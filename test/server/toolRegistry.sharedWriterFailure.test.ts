import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DefaultAfterToolCallHandler } from "../../src/server/toolRegistry";
import {
  JsonToolOutputArtifactWriter,
  type ToolOutputArtifactFileSystem,
} from "../../src/server/toolOutputArtifactWriter";
import { ToolOutputArtifactLedger } from "../../src/server/toolOutputArtifactLedger";
import { createStructuredToolResponse, getStructuredPayload } from "../../src/utils/toolUtils";
import { serverConfig } from "../../src/utils/ServerConfig";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";

/**
 * Interaction of #10078/#10079 (one shared writer per directory, prune deletes only
 * issued artifacts) with #10080 (a mutating tool's artifact write failure is served
 * inline). The real JsonToolOutputArtifactWriter runs behind the real handler with a
 * fake filesystem whose first write fails.
 */
describe("shared artifact writer after a failed write (#10079 + #10080)", () => {
  const DIR = "/tmp/shared-writer-artifacts";
  const NOW = 1_700_000_000_000;

  let originalDir: string | undefined;
  let ensureCalls: number;
  let writes: string[];
  let failNextWrite: boolean;
  let listed: Array<{ path: string; name: string; isFile: boolean; mtimeMs: number }>;
  let deleted: string[];
  let ledger: ToolOutputArtifactLedger;
  let created: number;
  let handler: DefaultAfterToolCallHandler;
  let timer: FakeTimer;

  const fileSystem: ToolOutputArtifactFileSystem = {
    ensureDirectory: () => {
      ensureCalls += 1;
    },
    assertWritableDirectory: () => {},
    writeFileExclusive: (filePath) => {
      if (failNextWrite) {
        failNextWrite = false;
        throw new Error("disk full");
      }
      writes.push(filePath);
    },
    listFiles: () => listed,
    deleteFile: (filePath) => void deleted.push(filePath),
  };

  const tapPayload = () => ({
    success: true,
    observation: {
      updatedAt: 1,
      screenSize: { width: 1080, height: 1920 },
      systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
      viewHierarchy: {
        hierarchy: { node: { "resource-id": "com.example:id/root" } },
      },
    },
  });

  const tapOn = async () => {
    const result = await handler.handle({
      name: "tapOn",
      args: {},
      device: undefined,
      internalCall: false,
      response: createStructuredToolResponse(tapPayload()),
      sessionUuid: "session-1",
      shouldResolveDevice: false,
      timer,
      toolStartMs: 0,
    });
    return getStructuredPayload(result.finalizedResponse) as Record<string, any>;
  };

  beforeEach(() => {
    originalDir = serverConfig.getToolOutputsDir();
    serverConfig.setToolOutputsDir(DIR);
    ensureCalls = 0;
    writes = [];
    failNextWrite = false;
    listed = [];
    deleted = [];
    created = 0;
    ledger = new ToolOutputArtifactLedger();
    timer = new FakeTimer();
    timer.setCurrentTime(NOW);
    handler = new DefaultAfterToolCallHandler((outputDirectory, writerTimer, retention) => {
      created += 1;
      return new JsonToolOutputArtifactWriter({
        outputDirectory,
        fileSystem,
        timer: writerTimer,
        retention,
        ledger,
        idGenerator: new FakeIdGenerator(["a", "b", "c", "d"]),
      });
    });
  });

  afterEach(() => {
    serverConfig.setToolOutputsDir(originalDir);
  });

  test("a failed write is served inline and the cached writer still writes the next call's artifact", async () => {
    failNextWrite = true;

    const first = await tapOn();
    expect(first.success).toBe(true);
    expect(first.artifact).toBeUndefined();
    expect(first.observation).toBeDefined();
    expect(first.observation.artifact).toBeUndefined();
    expect(writes).toHaveLength(0);

    timer.advanceTime(1_000);
    const second = await tapOn();
    expect(second.artifact ?? second.observation?.artifact).toBeDefined();
    expect(writes).toHaveLength(1);
    // One writer served both calls, and the failure forced directory re-validation.
    expect(created).toBe(1);
    expect(ensureCalls).toBe(2);
  });

  test("the failed write leaves no ledger entry for the prune or resource listing to see", async () => {
    failNextWrite = true;
    await tapOn();
    expect(ledger.size).toBe(0);

    timer.advanceTime(1_000);
    await tapOn();
    expect(ledger.size).toBe(1);
    const only = writes[0];
    expect(ledger.resolve(only.slice(only.lastIndexOf("/") + 1))?.path).toBe(only);
  });

  test("the prune after a failed write deletes only issued artifacts, never a shared sibling", async () => {
    const old = NOW - 30 * 24 * 60 * 60 * 1000;
    const issued = `${NOW - 1}-tapOn-prev.json`;
    listed = [
      { path: `${DIR}/package.json`, name: "package.json", isFile: true, mtimeMs: old },
      { path: `${DIR}/${issued}`, name: issued, isFile: true, mtimeMs: old },
    ];
    failNextWrite = true;
    await tapOn();
    // The first call's prune ran before the write failed (throttle consumed), so the
    // second call is within the prune interval: nothing more is deleted or re-listed.
    timer.advanceTime(1_000);
    await tapOn();

    expect(deleted).toEqual([`${DIR}/${issued}`]);
    expect(deleted).not.toContain(`${DIR}/package.json`);
  });
});
