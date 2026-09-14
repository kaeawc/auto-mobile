import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../src/models";
import { ResourceRegistry, type ResourceReadContext } from "../../src/server/resourceRegistry";
import { registerSessionLogResources } from "../../src/server/sessionLogResources";
import { SESSION_LOG_RESOURCE_TEMPLATE } from "../../src/server/sessionLogContract";
import type {
  SessionLogCollectRequest,
  SessionLogService,
} from "../../src/server/sessionLogService";

const sessionUuid = "session-123";
const device: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };

class RecordingSessionLogService implements SessionLogService {
  readonly collects: SessionLogCollectRequest[] = [];
  failure: Error | null = null;

  async collect(request: SessionLogCollectRequest) {
    this.collects.push(request);
    if (this.failure) {
      throw this.failure;
    }
    return {
      sessionUuid: request.sessionUuid,
      deviceId: request.device.deviceId,
      platform: request.device.platform,
      appId: request.request.appId,
      maxBytes: request.request.maxBytes,
      files: {
        status: "ok" as const,
        container: "documents" as const,
        entries: [{ path: "app.log", status: "read" as const, text: "hi" }],
      },
    };
  }

  async resetAppLogs(): Promise<never> {
    throw new Error("not used by the resource");
  }
}

function harness(active: boolean = true) {
  const service = new RecordingSessionLogService();
  const resolverCalls: string[] = [];
  let serviceResolved = 0;
  registerSessionLogResources({
    resolveActiveSession: (uuid) => {
      resolverCalls.push(uuid);
      return active ? { sessionUuid: uuid, device } : undefined;
    },
    service: () => {
      serviceResolved += 1;
      return service;
    },
  });
  return { service, resolverCalls, serviceResolved: () => serviceResolved };
}

function read(uri: string, context: ResourceReadContext = { sessionUuid }) {
  const match = ResourceRegistry.matchTemplate(uri);
  expect(match).toBeDefined();
  const { template, params } = match!;
  if (!("handlerWithReadContext" in template)) {
    throw new Error("session log resource must read its session context");
  }
  return template.handlerWithReadContext(params, context);
}

const baseUri = `automobile:device-session/${sessionUuid}/apps/com.example.app/logs`;
const appLogPathsQuery = "pathsJson=%5B%22app.log%22%5D";

describe("session log resources (#7006)", () => {
  beforeEach(() => ResourceRegistry.clearResources());
  afterEach(() => ResourceRegistry.clearResources());

  test("registers the session-scoped template", () => {
    harness();
    expect(ResourceRegistry.getTemplateDefinitions().map((t) => t.uriTemplate)).toContain(
      SESSION_LOG_RESOURCE_TEMPLATE,
    );
  });

  test("collects for the session's own device and returns JSON on the canonical URI", async () => {
    const { service } = harness();
    const controller = new AbortController();

    const content = await read(`${baseUri}?${appLogPathsQuery}&lastSeconds=30`, {
      sessionUuid,
      signal: controller.signal,
    });

    expect(content.mimeType).toBe("application/json");
    expect(content.uri).toBe(
      `${baseUri}?container=documents&${appLogPathsQuery}&lastSeconds=30&level=default&maxBytes=262144`,
    );
    expect(JSON.parse(content.text!)).toMatchObject({
      sessionUuid,
      deviceId: "emulator-5554",
      files: { status: "ok", entries: [{ path: "app.log", status: "read" }] },
    });
    expect(service.collects).toHaveLength(1);
    expect(service.collects[0]).toMatchObject({
      sessionUuid,
      device,
      signal: controller.signal,
      request: { appId: "com.example.app", files: { container: "documents", paths: ["app.log"] } },
    });
  });

  test("refuses another session's read before resolving anything", async () => {
    const { service, resolverCalls, serviceResolved } = harness();

    const content = await read(`${baseUri}?${appLogPathsQuery}`, { sessionUuid: "session-other" });

    expect(JSON.parse(content.text!)).toEqual({
      code: "SESSION_NOT_BOUND",
      error: "This resource can only be read by its bound device session.",
    });
    expect(content.uri).toBe(`${baseUri}?${appLogPathsQuery}`);
    expect(resolverCalls).toEqual([]);
    expect(serviceResolved()).toBe(0);
    expect(service.collects).toEqual([]);
  });

  test("reports an inactive session without constructing the service", async () => {
    const { service, serviceResolved } = harness(false);

    const content = await read(`${baseUri}?${appLogPathsQuery}`);

    expect(JSON.parse(content.text!)).toEqual({
      code: "SESSION_NOT_ACTIVE",
      error: `No active device session found for sessionUuid ${sessionUuid}.`,
    });
    expect(serviceResolved()).toBe(0);
    expect(service.collects).toEqual([]);
  });

  test("rejects traversal, unbounded reads, and unknown params before touching the device", async () => {
    const { service } = harness();

    for (const [query, message] of [
      ["pathsJson=%5B%22..%2Fshared%2Fapp.log%22%5D", "'..' segments"],
      [`${appLogPathsQuery}&maxBytes=99999999`, "Invalid maxBytes"],
      ["lastSeconds=86400", "Invalid lastSeconds"],
      [`${appLogPathsQuery}&deviceId=other`, "Unknown session log query parameter: deviceId"],
      ["", "at least one source"],
    ] as const) {
      const content = await read(query ? `${baseUri}?${query}` : baseUri);
      const body = JSON.parse(content.text!);
      expect(body.code).toBe("INVALID_REQUEST");
      expect(body.error).toContain(message);
    }
    expect(service.collects).toEqual([]);
  });

  test("turns a whole-collection failure into a JSON error, not a thrown read", async () => {
    const { service } = harness();
    service.failure = new Error("Session logs are not supported on tvos.");

    const content = await read(`${baseUri}?${appLogPathsQuery}`);

    expect(JSON.parse(content.text!)).toEqual({
      code: "COLLECTION_FAILED",
      error: "Session logs are not supported on tvos.",
    });
  });
});
