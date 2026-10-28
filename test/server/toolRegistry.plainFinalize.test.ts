import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { z } from "zod/v4";
import { DefaultAfterToolCallHandler, ToolRegistryClass } from "../../src/server/toolRegistry";
import { markInternalToolCall } from "../../src/daemon/internalToolCall";
import { createStructuredToolResponse, stringifyToolResponse } from "../../src/utils/toolUtils";
import { resourceLinkField } from "../../src/utils/schemaHelpers";
import { serverConfig } from "../../src/utils/ServerConfig";
import { logger } from "../../src/utils/logger";
import { FakeArtifactWriter } from "../fakes/FakeArtifactWriter";
import { FakeLogger } from "../fakes/FakeLogger";
import { FakeTimer } from "../fakes/FakeTimer";

/**
 * Plain `register()` tools run through response finalization (#13942): only the
 * hard-ceiling spill and the `resourceLink` opt-in apply, so a normal-sized plain
 * response is unchanged on the wire.
 */
describe("plain-registered tools are finalized (#13942)", () => {
  const TOOL = "plainFinalizeProbe";
  const outputSchema = z.object({ success: z.boolean(), body: z.string() });
  let writer: FakeArtifactWriter;
  let writersCreated: number;
  let registry: ToolRegistryClass;
  let restorePipeline: () => void;
  let payload: Record<string, unknown>;
  let previousOutputsDir: string | undefined;

  const envelope = (value: Record<string, unknown>) => createStructuredToolResponse(value);
  type Envelope = ReturnType<typeof envelope>;
  const call = async (args: Record<string, unknown> = {}): Promise<Envelope> =>
    (await registry.getTool(TOOL)!.handler(args, undefined, undefined)) as Envelope;
  const links = (response: Envelope) =>
    (response.content as Array<{ type: string }>).filter((part) => part.type === "resource_link");
  const oversized = () => ({ success: true, body: "x".repeat(70 * 1024) });

  beforeEach(() => {
    previousOutputsDir = serverConfig.getToolOutputsDir();
    serverConfig.setToolOutputsDir(undefined);
    writer = new FakeArtifactWriter();
    writersCreated = 0;
    registry = new ToolRegistryClass(new FakeTimer(), new FakeLogger(), null);
    restorePipeline = registry.setPipelineOverridesForTesting({
      plainToolFinalizer: new DefaultAfterToolCallHandler(() => {
        writersCreated += 1;
        return writer;
      }),
    });
    payload = { success: true, body: "small" };
    registry.register(
      TOOL,
      "plain finalize probe",
      z.object({ resourceLink: resourceLinkField() }).passthrough(),
      async () => envelope(payload),
      { outputSchema },
    );
  });

  afterEach(() => {
    restorePipeline();
    serverConfig.setToolOutputsDir(previousOutputsDir);
  });

  test("a normal-sized response is byte-identical to the handler's envelope", async () => {
    // `observation` and `extras` would be reshaped/stripped by the device pipeline;
    // a plain tool keeps them exactly as its handler produced them.
    payload = {
      success: true,
      body: "small",
      observation: { updatedAt: 1, extras: { note: "kept" } },
      extras: { kept: true },
    };
    const response = await call();
    expect(JSON.stringify(response)).toBe(JSON.stringify(envelope(payload)));
    expect(writer.writes).toHaveLength(0);
  });

  test("a configured tool-output directory does not spill a normal-sized response", async () => {
    serverConfig.setToolOutputsDir("/tmp/plain-finalize-artifacts");
    const response = await call();
    expect(JSON.stringify(response)).toBe(JSON.stringify(envelope(payload)));
    expect(writer.writes).toHaveLength(0);
    expect(links(response)).toHaveLength(0);
  });

  test("an over-the-ceiling response spills with its headline and a resource_link", async () => {
    payload = oversized();
    const response = await call();
    expect(writer.writes.map((write) => write.payload)).toEqual(["ToolResponse"]);
    expect(response.structuredContent).toMatchObject({
      success: true,
      artifact: { resourceUri: `automobile:tool-output/${TOOL}-1.json` },
    });
    expect(response.content[0]!.text).toBe(stringifyToolResponse(response.structuredContent));
    // The required `body` stays inline only as a bounded, marked residue.
    expect(response.content[0]!.text.length).toBeLessThan(8 * 1024);
    expect(response.content[0]!.text).toContain("complete value in the tool-output artifact");
    expect(links(response)).toHaveLength(1);
  });

  test("an internal call is never spilled and builds no writer", async () => {
    payload = oversized();
    const response = await call(markInternalToolCall({ resourceLink: true }));
    expect(JSON.stringify(response)).toBe(JSON.stringify(envelope(payload)));
    expect(writersCreated).toBe(0);
    expect(links(response)).toHaveLength(0);
  });

  test("resourceLink: true spills a mid-sized response and links it", async () => {
    payload = { success: true, body: "y".repeat(8 * 1024) };
    const response = await call({ resourceLink: true });
    expect(writer.writes).toHaveLength(1);
    expect(response.content[0]!.text.length).toBeLessThan(8 * 1024);
    expect(links(response)).toHaveLength(1);
  });

  test("a failed spill serves the payload un-spilled and warns", async () => {
    payload = oversized();
    writer.throwOnWrite = new Error("disk full");
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const response = await call();
      expect(JSON.stringify(response)).toBe(JSON.stringify(envelope(payload)));
      expect(warn.mock.calls.map((args) => String(args[0]))).toEqual([
        expect.stringContaining(`could not spill the oversized ${TOOL} response`),
      ]);
    } finally {
      warn.mockRestore();
    }
  });
});
