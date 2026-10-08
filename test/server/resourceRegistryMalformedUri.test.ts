import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { registerAppFileResources } from "../../src/server/appFileResources";
import { registerAppResources } from "../../src/server/appResources";
import { registerBootedDeviceResources } from "../../src/server/bootedDeviceResources";
import { registerDataStoreResources } from "../../src/server/dataStoreResources";
import { registerDatabaseResources } from "../../src/server/databaseResources";
import { registerDeviceImageResources } from "../../src/server/deviceImageResources";
import { registerDeviceSnapshotResources } from "../../src/server/deviceSnapshotResources";
import { registerFailuresResources } from "../../src/server/failuresResources";
import { registerFeatureFlagResources } from "../../src/server/featureFlagResources";
import { registerLocalizationResources } from "../../src/server/localizationResources";
import { registerNavigationResources } from "../../src/server/navigationResources";
import { registerNetworkResources } from "../../src/server/networkResources";
import { registerObservationResources } from "../../src/server/observationResources";
import { registerPerformanceResources } from "../../src/server/performanceResources";
import { ResourceRegistry } from "../../src/server/resourceRegistry";
import { decodeSegmentOrThrow } from "../../src/server/resourceUriSegments";
import { registerSessionLogResources } from "../../src/server/sessionLogResources";
import { registerSharedStorageResources } from "../../src/server/sharedStorageResources";
import { registerStorageCapabilityResources } from "../../src/server/storageCapabilityResources";
import { registerStorageResources } from "../../src/server/storageResources";
import { registerTestRunResources } from "../../src/server/testRunResources";
import { registerTestTimingResources } from "../../src/server/testTimingResources";
import { registerToolCatalogResources } from "../../src/server/toolCatalogResource";
import { registerToolOutputResources } from "../../src/server/toolOutputResources";
import { registerVideoRecordingResources } from "../../src/server/videoRecordingResources";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeMcpServer } from "../fakes/FakeMcpServer";

// Issue #10117: ResourceRegistry hands path captures to handlers undecoded, so any
// handler that decodes one must own a malformed percent-escape. Feed `%zz` to every
// variable of every registered resource template and require that nothing escapes as
// a raw URIError — each read yields a content envelope or a structured error.

const MALFORMED = "bad%zz";

// A value each variable accepts, so the malformed variable under test is the only
// reason a handler can reject and later segments still get decoded.
const VALID_VALUES: Record<string, string> = {
  container: "documents",
  userId: "1",
  versionCode: "1",
  versionCodeA: "1",
  versionCodeB: "1",
  limit: "1",
  offset: "0",
  platform: "android",
};

function registerEveryResource(): void {
  registerObservationResources();
  registerToolOutputResources();
  registerBootedDeviceResources();
  registerDeviceImageResources();
  registerAppResources();
  registerNavigationResources();
  registerTestTimingResources();
  registerTestRunResources();
  registerPerformanceResources();
  registerVideoRecordingResources();
  registerLocalizationResources();
  registerDeviceSnapshotResources();
  registerDatabaseResources();
  registerFailuresResources();
  registerStorageResources();
  registerStorageCapabilityResources();
  registerDataStoreResources();
  registerAppFileResources();
  registerSessionLogResources();
  registerSharedStorageResources();
  registerFeatureFlagResources();
  registerToolCatalogResources();
  registerNetworkResources();
}

interface MalformedRead {
  label: string;
  uri: string;
}

// Expand each template once per variable, placing the malformed value in that
// variable and a valid placeholder in the others. RFC 6570 `{?a,b}` query
// variables become `?name=value`; `{params}` is a raw query string.
function malformedReadsFor(uriTemplate: string): MalformedRead[] {
  const queryExpression = uriTemplate.match(/\{\?([\w,]+)\}$/);
  const queryNames = queryExpression?.[1].split(",") ?? [];
  const pathTemplate = queryExpression
    ? uriTemplate.slice(0, uriTemplate.length - queryExpression[0].length)
    : uriTemplate;
  const pathNames = [...pathTemplate.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
  const fill = (target: string, name: string): string =>
    name === target ? MALFORMED : (VALID_VALUES[name] ?? "x");
  const reads = pathNames.map((target) => ({
    label: `${uriTemplate} with malformed {${target}}`,
    uri: pathTemplate.replace(/\{(\w+)\}/g, (_match, name: string) => fill(target, name)),
  }));
  for (const target of queryNames) {
    const base = pathTemplate.replace(/\{(\w+)\}/g, (_match, name: string) => fill("", name));
    reads.push({
      label: `${uriTemplate} with malformed ?${target}`,
      uri: `${base}?${target}=${MALFORMED}`,
    });
  }
  return reads;
}

function collectMalformedReads(): MalformedRead[] {
  // registerAppResources kicks off installed-app discovery, so a fake device manager
  // (no booted devices) must be in place before anything registers: nothing here may
  // reach adb, simctl or a CtrlProxy.
  PlatformDeviceManagerFactory.setInstance(new FakeDeviceManager());
  registerEveryResource();
  return ResourceRegistry.getTemplateDefinitions().flatMap((template) =>
    malformedReadsFor(template.uriTemplate),
  );
}

const reads = collectMalformedReads();

describe("every registered resource template tolerates a malformed percent-escape (#10117)", () => {
  beforeAll(() => {
    PlatformDeviceManagerFactory.setInstance(new FakeDeviceManager());
    registerEveryResource();
  });

  afterAll(() => {
    ResourceRegistry.clearResources();
    ResourceRegistry.clearServersForTesting();
    PlatformDeviceManagerFactory.reset();
  });

  test("the sweep covers the whole template catalogue", () => {
    expect(reads.length).toBeGreaterThan(60);
    const swept = new Set(reads.map((read) => read.label.split(" with ")[0]));
    const registered = ResourceRegistry.getTemplateDefinitions()
      .map((template) => template.uriTemplate)
      .filter((uriTemplate) => /\{/.test(uriTemplate));
    expect(registered.filter((uriTemplate) => !swept.has(uriTemplate))).toEqual([]);
  });

  test.each(reads.map((read) => [read.label, read.uri] as const))(
    "%s: the handler never throws a raw URIError",
    async (_label, uri) => {
      const matched = ResourceRegistry.matchTemplate(uri);
      expect(matched).toBeDefined();
      const { template, params } = matched!;

      const outcome = await (
        "handlerWithReadContext" in template
          ? template.handlerWithReadContext(params, {})
          : template.handler(params)
      ).then(
        (content) => ({ content }),
        (error: unknown) => ({ error }),
      );

      if ("error" in outcome) {
        expect(outcome.error).toBeInstanceOf(Error);
        expect(outcome.error).not.toBeInstanceOf(URIError);
      } else {
        expect(typeof outcome.content.uri).toBe("string");
      }
    },
  );

  test("the read handler never surfaces a URIError either", async () => {
    const server = new FakeMcpServer();
    ResourceRegistry.registerWithServer(server as unknown as McpServer, () => ({}));
    const readHandler = server.server.handlersBySchema.get(ReadResourceRequestSchema);
    expect(readHandler).toBeDefined();

    for (const { uri } of reads) {
      const outcome = await readHandler!({ params: { uri } }, {}).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(outcome).not.toBeInstanceOf(URIError);
    }
  });
});

describe("registry maps a contract parser's malformed-segment error to invalid params", () => {
  afterAll(() => {
    ResourceRegistry.clearResources();
    ResourceRegistry.clearServersForTesting();
  });

  test("decodeSegmentOrThrow surfaces as -32602 with the URI, not -32603", async () => {
    ResourceRegistry.clearResources();
    ResourceRegistry.registerTemplate(
      "automobile:test/contract/{name}",
      "Contract",
      "Decodes its capture with decodeSegmentOrThrow",
      "application/json",
      async (params) => ({ uri: "automobile:test", text: decodeSegmentOrThrow(params.name) }),
    );
    const server = new FakeMcpServer();
    ResourceRegistry.registerWithServer(server as unknown as McpServer, () => ({}));
    const readHandler = server.server.handlersBySchema.get(ReadResourceRequestSchema)!;
    const uri = "automobile:test/contract/%E0%A4%A";

    const error = await readHandler({ params: { uri } }, {}).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe(-32602);
    expect((error as McpError).message).toContain(`(${uri})`);
  });
});

describe("registry backstop for a handler that decodes a capture unguarded (#10117)", () => {
  afterAll(() => {
    ResourceRegistry.clearResources();
    ResourceRegistry.clearServersForTesting();
  });

  test("a URIError from a template handler becomes a structured invalid-params error", async () => {
    ResourceRegistry.clearResources();
    ResourceRegistry.registerTemplate(
      "automobile:test/unguarded/{name}",
      "Unguarded",
      "Decodes its capture without a guard",
      "application/json",
      async (params) => ({ uri: "automobile:test", text: decodeURIComponent(params.name) }),
    );
    const server = new FakeMcpServer();
    ResourceRegistry.registerWithServer(server as unknown as McpServer, () => ({}));
    const readHandler = server.server.handlersBySchema.get(ReadResourceRequestSchema)!;

    const error = await readHandler({ params: { uri: "automobile:test/unguarded/a%" } }, {}).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe(-32602);
    expect((error as McpError).message).toContain("Malformed resource URI");
    expect((error as McpError).message).toContain("automobile:test/unguarded/a%");
  });

  test("any other handler error is rethrown unchanged", async () => {
    ResourceRegistry.clearResources();
    const failure = new Error("boom");
    ResourceRegistry.registerTemplate(
      "automobile:test/failing/{name}",
      "Failing",
      "Throws an ordinary error",
      "application/json",
      async () => {
        throw failure;
      },
    );
    const server = new FakeMcpServer();
    ResourceRegistry.registerWithServer(server as unknown as McpServer, () => ({}));
    const readHandler = server.server.handlersBySchema.get(ReadResourceRequestSchema)!;

    const error = await readHandler({ params: { uri: "automobile:test/failing/a" } }, {}).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBe(failure);
  });
});
