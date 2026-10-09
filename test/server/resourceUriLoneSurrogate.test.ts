import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { buildAppFileResourceUri } from "../../src/server/appFileContract";
import { buildObservationScreenshotUri } from "../../src/server/observationResourceUris";
import { ResourceRegistry } from "../../src/server/resourceRegistry";
import { encodeUriSegment } from "../../src/utils/encodeUriSegment";
import { buildNavigationNodeScreenshotUri } from "../../src/utils/navigationResourceUri";
import { FakeMcpServer } from "../fakes/FakeMcpServer";

// A device can report a name holding a lone UTF-16 surrogate. Building a resource URI
// from it must not throw, and a URIError that does come out of a handler for a
// WELL-FORMED request URI must not be reported as the client's malformed URI (#10135).

const LONE_SURROGATE = "\uD800";

describe("resource URI encoders accept lone surrogates (#10135)", () => {
  test("encodeUriSegment replaces a lone surrogate instead of throwing", () => {
    expect(() => encodeURIComponent(`a${LONE_SURROGATE}b`)).toThrow(URIError);
    expect(encodeUriSegment(`a${LONE_SURROGATE}b`)).toBe("a%EF%BF%BDb");
    expect(encodeUriSegment("a\uDC00")).toBe("a%EF%BF%BD");
  });

  test("well-formed strings encode exactly like encodeURIComponent", () => {
    for (const value of ["com.example.app", "a b/c?d#e", "café", "\u{1F600}", "50%", ""]) {
      expect(encodeUriSegment(value)).toBe(encodeURIComponent(value));
    }
  });

  test("an app file URI is built for a device-reported name with a lone surrogate", () => {
    const uri = buildAppFileResourceUri({
      deviceId: "emulator-5554",
      appId: "com.example",
      container: "files",
      path: `docs/na${LONE_SURROGATE}me.txt`,
    });

    expect(uri).toBe(
      "automobile:devices/emulator-5554/apps/com.example/files/files/docs/na%EF%BF%BDme.txt",
    );
  });

  test("other resource URI builders accept one too", () => {
    expect(buildObservationScreenshotUri(`d${LONE_SURROGATE}`, "obs")).toBe(
      "automobile:observation/d%EF%BF%BD/obs/screenshot",
    );
    expect(buildNavigationNodeScreenshotUri(1, `app${LONE_SURROGATE}`)).toContain(
      "appId=app%EF%BF%BD",
    );
  });

  // Reading every src/server file is IO, not the behaviour under test: scan once in
  // beforeAll so a loaded runner's disk latency is not charged to the test.
  let offenders: string[] = [];
  beforeAll(() => {
    const roots = [
      ...readdirSync(`${import.meta.dir}/../../src/server`).map((name) => `src/server/${name}`),
      "src/utils/navigationResourceUri.ts",
    ].filter((path) => path.endsWith(".ts"));
    offenders = roots.filter((path) =>
      /(?<![`\w.])encodeURIComponent\(/.test(
        readFileSync(`${import.meta.dir}/../../${path}`, "utf8"),
      ),
    );
  });

  test("no resource URI builder calls encodeURIComponent directly", () => {
    expect(offenders).toEqual([]);
  });
});

describe("the registry backstop blames the client only for its own URI (#10135)", () => {
  let readHandler: (request: { params: { uri: string } }, extra: object) => Promise<unknown>;

  beforeEach(() => {
    ResourceRegistry.clearResources();
    ResourceRegistry.registerTemplate(
      "automobile:test/encode/{name}",
      "Encodes",
      "Builds a URI from a device-reported name with the raw encoder",
      "application/json",
      async () => ({ uri: "automobile:test", text: encodeURIComponent(LONE_SURROGATE) }),
    );
    ResourceRegistry.registerTemplate(
      "automobile:test/decode/{name}",
      "Decodes",
      "Decodes its capture without a guard",
      "application/json",
      async (params) => ({ uri: "automobile:test", text: decodeURIComponent(params.name) }),
    );
    const server = new FakeMcpServer();
    ResourceRegistry.registerWithServer(server as unknown as McpServer, () => ({}));
    const handler = server.server.handlersBySchema.get(ReadResourceRequestSchema);
    if (!handler) {
      throw new Error("read handler not registered");
    }
    readHandler = handler;
  });

  afterEach(() => {
    ResourceRegistry.clearResources();
    ResourceRegistry.clearServersForTesting();
  });

  function failureOf(uri: string): Promise<unknown> {
    return readHandler({ params: { uri } }, {}).then(
      () => undefined,
      (caught: unknown) => caught,
    );
  }

  test("a URIError from encoding on a well-formed request is not reported as a malformed URI", async () => {
    const error = await failureOf("automobile:test/encode/fine");

    expect(error).toBeInstanceOf(URIError);
    expect(error).not.toBeInstanceOf(McpError);
  });

  test("a malformed percent-escape in the request URI is still invalid-params", async () => {
    const error = await failureOf("automobile:test/decode/a%");

    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe(-32602);
    expect((error as McpError).message).toContain("Malformed resource URI");
  });

  test("a malformed escape in the request still wins when the handler throws a URIError for it", async () => {
    const error = await failureOf("automobile:test/encode/bad%zz");

    expect(error).toBeInstanceOf(McpError);
  });
});
