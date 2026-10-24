import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../src/models";
import type {
  KnownPerformanceTrace,
  PerformanceTraceResult,
} from "../../src/features/performanceTrace/PerformanceTraceManager";
import {
  PERFORMANCE_TRACE_RESOURCE_TEMPLATE,
  registerPerformanceTraceResources,
  type TraceArtifactReader,
} from "../../src/server/performanceTraceResources";
import { ResourceRegistry, type ResourceReadContext } from "../../src/server/resourceRegistry";

const sessionUuid = "session-123";
const device: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };
const baseUri = `automobile:device-session/${sessionUuid}/performance-traces`;

function traceResult(overrides: Partial<PerformanceTraceResult> = {}): PerformanceTraceResult {
  return {
    traceId: "trace-1",
    state: "stopped",
    deviceId: device.deviceId,
    platform: "android",
    template: "hitches",
    startedAt: "2026-10-23T10:00:00.000Z",
    timeLimitMs: 30_000,
    artifactPath: "/artifacts/trace-1.perfetto-trace",
    summary: { durationMs: 900 },
    warnings: [],
    ...overrides,
  };
}

class FakeArtifacts implements TraceArtifactReader {
  info: { isFile: boolean; size: number } | undefined = { isFile: true, size: 10 };
  readonly ranges: Array<[number, number]> = [];

  async stat() {
    return this.info;
  }

  async readRange(_path: string, offset: number, length: number) {
    this.ranges.push([offset, length]);
    return Buffer.from("0123456789".slice(offset, offset + length));
  }
}

function harness(
  options: { known?: KnownPerformanceTrace; active?: boolean; artifacts?: FakeArtifacts } = {},
) {
  const artifacts = options.artifacts ?? new FakeArtifacts();
  const known =
    "known" in options ? options.known : { result: traceResult(), ownerSessionUuid: sessionUuid };
  registerPerformanceTraceResources(
    { lookup: (traceId) => (traceId === "trace-1" ? known : undefined) },
    {
      resolveActiveSession: (uuid) =>
        options.active === false ? undefined : { sessionUuid: uuid, device },
      artifacts,
    },
  );
  return { artifacts };
}

async function parse(uri: string, context: ResourceReadContext = { sessionUuid }) {
  const match = ResourceRegistry.matchTemplate(uri);
  expect(match).toBeDefined();
  const { template, params } = match!;
  if (!("handlerWithReadContext" in template)) {
    throw new Error("performance trace resource must read its session context");
  }
  return JSON.parse((await template.handlerWithReadContext(params, context)).text!);
}

describe("performance trace resource (#14102)", () => {
  beforeEach(() => ResourceRegistry.clearResources());
  afterEach(() => ResourceRegistry.clearResources());

  test("registers the session-scoped template", () => {
    harness();
    expect(ResourceRegistry.getTemplateDefinitions().map((t) => t.uriTemplate)).toContain(
      PERFORMANCE_TRACE_RESOURCE_TEMPLATE,
    );
  });

  test("returns the trace result with artifact metadata and no bytes by default", async () => {
    const { artifacts } = harness();
    expect(await parse(`${baseUri}/trace-1`)).toMatchObject({
      traceId: "trace-1",
      summary: { durationMs: 900 },
      artifact: { available: true, kind: "file", byteCount: 10 },
    });
    expect(artifacts.ranges).toEqual([]);
  });

  test("returns a bounded base64 slice and reports truncation", async () => {
    const { artifacts } = harness();
    const body = await parse(`${baseUri}/trace-1?offset=2&maxBytes=4`);
    expect(body.artifact).toMatchObject({
      offset: 2,
      returnedBytes: 4,
      truncated: true,
      base64: Buffer.from("2345").toString("base64"),
    });
    expect(artifacts.ranges).toEqual([[2, 4]]);
  });

  test("the last slice is not truncated and an offset past the end is empty", async () => {
    harness();
    expect((await parse(`${baseUri}/trace-1?offset=8&maxBytes=100`)).artifact).toMatchObject({
      returnedBytes: 2,
      truncated: false,
    });
    expect((await parse(`${baseUri}/trace-1?offset=50&maxBytes=4`)).artifact).toMatchObject({
      returnedBytes: 0,
      base64: "",
    });
  });

  test("describes an iOS bundle directory without bytes", async () => {
    const artifacts = new FakeArtifacts();
    artifacts.info = { isFile: false, size: 0 };
    harness({ artifacts });
    expect((await parse(`${baseUri}/trace-1?maxBytes=4`)).artifact).toEqual({
      available: true,
      kind: "directory",
    });
    expect(artifacts.ranges).toEqual([]);
  });

  test("reports a missing artifact", async () => {
    const artifacts = new FakeArtifacts();
    artifacts.info = undefined;
    harness({ artifacts });
    expect((await parse(`${baseUri}/trace-1`)).artifact).toEqual({ available: false });
  });

  test.each(["maxBytes=-1", "maxBytes=1048577", "maxBytes=x", "offset=-1"])(
    "rejects %s",
    async (query) => {
      harness();
      expect(await parse(`${baseUri}/trace-1?${query}`)).toMatchObject({ code: "INVALID_REQUEST" });
    },
  );

  test("refuses a caller that does not own the session, and an inactive session", async () => {
    harness();
    expect(await parse(`${baseUri}/trace-1`, { sessionUuid: "someone-else" })).toMatchObject({
      code: "SESSION_NOT_BOUND",
    });
    ResourceRegistry.clearResources();
    harness({ active: false });
    expect(await parse(`${baseUri}/trace-1`)).toMatchObject({ code: "SESSION_NOT_ACTIVE" });
  });

  test("a connection reads traces of an earlier session it still owns", async () => {
    harness();
    const owned = new Set([sessionUuid]);
    const context = {
      sessionUuid: "later-session",
      ownsSession: (uuid: string) => owned.has(uuid),
    };
    expect(await parse(`${baseUri}/trace-1`, context)).toMatchObject({ traceId: "trace-1" });
    owned.clear();
    expect(await parse(`${baseUri}/trace-1`, context)).toMatchObject({ code: "SESSION_NOT_BOUND" });
  });

  test("never serves a trace started by another session or on another device", async () => {
    harness({ known: { result: traceResult(), ownerSessionUuid: "other" } });
    expect(await parse(`${baseUri}/trace-1`)).toMatchObject({ code: "NOT_FOUND" });
    ResourceRegistry.clearResources();
    harness({
      known: { result: traceResult({ deviceId: "emulator-5556" }), ownerSessionUuid: sessionUuid },
    });
    expect(await parse(`${baseUri}/trace-1`)).toMatchObject({ code: "NOT_FOUND" });
  });

  test("reports NOT_FOUND for an unknown or malformed trace id", async () => {
    harness();
    expect(await parse(`${baseUri}/trace-9`)).toMatchObject({ code: "NOT_FOUND" });
    expect(await parse(`${baseUri}/..%2Fsecret`)).toMatchObject({ code: "INVALID_REQUEST" });
  });
});
