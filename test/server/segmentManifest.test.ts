import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SEGMENT_MANIFEST_FILE,
  type StoppedSegment,
  writeSegmentManifest,
} from "../../src/server/segmentManifest";

describe("writeSegmentManifest", () => {
  let archive: string;
  let segment: StoppedSegment;

  beforeEach(async () => {
    archive = await fs.mkdtemp(path.join(os.tmpdir(), "segment-manifest-"));
    segment = {
      recordingId: "rec-1",
      filePath: path.join(archive, "video.mp4"),
      segmentIndex: 0,
    };
  });

  afterEach(async () => {
    await fs.rm(archive, { recursive: true, force: true });
  });

  test("warnings-free segments retain exactly the legacy manifest shape", async () => {
    const second = { ...segment, recordingId: "rec-2", segmentIndex: 1 };
    const manifestPath = await writeSegmentManifest("session", [segment, second]);
    expect(manifestPath).toBe(path.join(archive, SEGMENT_MANIFEST_FILE));
    expect(await fs.readFile(manifestPath!, "utf8")).toBe(
      `${JSON.stringify(
        {
          sessionId: "session",
          segmentCount: 2,
          segments: [segment, second].map(({ segmentIndex, recordingId, filePath }) => ({
            index: segmentIndex,
            recordingId,
            filePath,
          })),
        },
        null,
        2,
      )}\n`,
    );
  });

  test("includes supplied metadata only on its segment and deduplicates session warnings", async () => {
    const recordedPanel = { key: "inner", role: "inner" as const };
    const transitions = [
      { atMs: 1000, from: recordedPanel, to: { key: "cover", role: "cover" as const } },
    ];
    const warnings = ["segment warning"];
    const manifestPath = await writeSegmentManifest(
      "session",
      [
        { ...segment, recordedPanel, transitions, warnings },
        { ...segment, recordingId: "rec-2", segmentIndex: 1 },
      ],
      ["capture gap", "capture gap", "segment warning"],
    );
    expect(JSON.parse(await fs.readFile(manifestPath!, "utf8"))).toEqual({
      sessionId: "session",
      segmentCount: 2,
      videoWarnings: ["capture gap", "segment warning"],
      segments: [
        {
          index: 0,
          recordingId: "rec-1",
          filePath: segment.filePath,
          recordedPanel,
          transitions,
          warnings,
        },
        { index: 1, recordingId: "rec-2", filePath: segment.filePath },
      ],
    });
  });

  test("empty warnings are omitted while an explicitly supplied transition list is retained", async () => {
    const manifestPath = await writeSegmentManifest(
      "session",
      [{ ...segment, warnings: [], transitions: [] }],
      [],
    );
    expect(JSON.parse(await fs.readFile(manifestPath!, "utf8"))).toEqual({
      sessionId: "session",
      segmentCount: 1,
      segments: [{ index: 0, recordingId: "rec-1", filePath: segment.filePath, transitions: [] }],
    });
  });

  test("no segments produce no manifest", async () => {
    expect(await writeSegmentManifest("session", [], ["capture failed"])).toBeUndefined();
    expect(await fs.readdir(archive)).toEqual([]);
  });
});
