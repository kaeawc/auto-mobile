import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { FakeChildProcess } from "../../fakes/FakeChildProcess";
import { ActionableError } from "../../../src/models/ActionableError";
import {
  CAPTURE_CAPABILITY_PREFIX,
  ENCODED_VIDEO_CAPABILITY,
  IOSScreenCaptureHelper,
  type CaptureTarget,
  type DecodedEncodedVideo,
} from "../../../src/features/screen-stream";

function withFakeSpawner(
  target: CaptureTarget = { kind: "simulator", windowID: 1 }
): { fake: FakeChildProcess; helper: IOSScreenCaptureHelper } {
  const fake = new FakeChildProcess();
  const helper = new IOSScreenCaptureHelper({
    binaryPath: "/fake/screen-capture-helper",
    target,
    spawner: () => fake as unknown as ChildProcessWithoutNullStreams,
  });
  return { fake, helper };
}

function flush(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

const goldenKeyframeRecordHex: string = (() => {
  const golden = JSON.parse(
    readFileSync(new URL("../../fixtures/encoded-h264-golden-vectors.json", import.meta.url), "utf8")
  ) as { records: Array<{ name: string; recordHex: string }> };
  const record = golden.records.find(r => r.name === "keyframe");
  if (record === undefined) {throw new Error("keyframe golden record missing");}
  return record.recordHex;
})();

describe("IOSScreenCaptureHelper capability handshake (issue #4787)", () => {
  test("parses the capability marker, exposes it, and does not leak it as a stderr line", async () => {
    const { fake, helper } = withFakeSpawner();
    const capabilities: string[] = [];
    const stderr: string[] = [];
    helper.on("capability", token => capabilities.push(token));
    helper.on("stderr", line => stderr.push(line));
    helper.start();

    fake.stderr.push(Buffer.from(`${CAPTURE_CAPABILITY_PREFIX} ${ENCODED_VIDEO_CAPABILITY}\n`));
    await flush();

    expect(capabilities).toEqual([ENCODED_VIDEO_CAPABILITY]);
    expect(helper.supportsEncodedVideo()).toBe(true);
    expect([...helper.capabilities]).toEqual([ENCODED_VIDEO_CAPABILITY]);
    // Consumed as a structured marker, not surfaced as an opaque stderr line.
    expect(stderr).toEqual([]);
  });

  test("an old helper that never advertises the capability is detectable and yields an ActionableError", async () => {
    const { fake, helper } = withFakeSpawner();
    helper.start();

    // Old helper emits normal startup markers but no capability handshake line.
    fake.stderr.push(Buffer.from("capture-phase: permission-ready\n"));
    await flush();

    expect(helper.supportsEncodedVideo()).toBe(false);
    expect([...helper.capabilities]).toEqual([]);
    expect(() => helper.assertSupportsEncodedVideo()).toThrow(ActionableError);
    expect(() => helper.assertSupportsEncodedVideo()).toThrow(/encoded-video-h264/);
  });

  test("assertSupportsEncodedVideo passes once the capability was advertised", async () => {
    const { fake, helper } = withFakeSpawner();
    helper.start();
    fake.stderr.push(Buffer.from(`${CAPTURE_CAPABILITY_PREFIX} ${ENCODED_VIDEO_CAPABILITY}\n`));
    await flush();
    expect(() => helper.assertSupportsEncodedVideo()).not.toThrow();
  });

  test("surfaces an encoded-video record over stdout via the encodedVideo event, not as a frame", async () => {
    const { fake, helper } = withFakeSpawner();
    const video: DecodedEncodedVideo[] = [];
    const frames: number[] = [];
    helper.on("encodedVideo", v => video.push(v));
    helper.on("frame", () => frames.push(1));
    helper.start();

    fake.stdout.push(Buffer.from(goldenKeyframeRecordHex, "hex"));
    await flush();

    expect(frames).toEqual([]);
    expect(video).toHaveLength(1);
    expect(video[0].keyframe).toBe(true);
    expect(video[0].presentationTimestampMs).toBe(1000);
  });
});
