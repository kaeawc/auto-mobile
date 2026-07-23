import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CAPTURE_STAGES } from "../helpers/captureStageTimeline";

const repoRoot = join(import.meta.dir, "../..");

function read(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf8");
}

const INTEGRATION_TEST_PATH = "test/integration/webrtcDeviceCapture.integration.test.ts";

/**
 * The device lane needs a real emulator/simulator, so its instrumentation
 * cannot be exercised here. These guards pin the wiring instead: every stage is
 * marked, the record survives a failure, and no assertion depends on how long a
 * hosted runner happened to take (#4343).
 */
describe("#4343 device capture latency instrumentation", () => {
  test("marks every capture-to-browser stage in the device lane", () => {
    const source = read(INTEGRATION_TEST_PATH);

    for (const stage of CAPTURE_STAGES) {
      expect(source).toContain(`timeline.mark("${stage}")`);
    }
  });

  test("writes the latency record from the cleanup path so failures keep it", () => {
    const source = read(INTEGRATION_TEST_PATH);
    const finallyIndex = source.indexOf("} finally {");
    const recordIndex = source.indexOf("stage-latency.json");

    expect(finallyIndex).toBeGreaterThan(0);
    expect(recordIndex).toBeGreaterThan(finallyIndex);
  });

  test("prints the formatted record so a passing CI run reports its timings", () => {
    const source = read(INTEGRATION_TEST_PATH);

    expect(source).toContain("formatCaptureStageRecord");
    expect(source).toMatch(/console\.log\(/);
  });

  test("asserts nothing about measured durations", () => {
    const source = read(INTEGRATION_TEST_PATH);
    const timingAssertions = source
      .split("\n")
      .filter(line => /expect\(/.test(line))
      .filter(line => /timeline|record|elapsedMs|deltaMs|captureToBrowserMs|latency/.test(line));

    expect(timingAssertions).toEqual([]);
  });

  test("mirrors the Android capture fps from the video-server default quality preset", () => {
    const integration = read(INTEGRATION_TEST_PATH);
    const encoder = read("src/features/webrtc/PersistentEncoderH264Source.ts");
    const preset = read(
      "android/video-server/src/main/kotlin/dev/jasonpearson/automobile/video/QualityPreset.kt"
    );

    // The lane runs the persistent encoder, which sends `--quality medium`.
    expect(encoder).toContain('this.options.quality ?? "medium"');
    const mediumFps = /MEDIUM\([^)]*fps\s*=\s*(\d+)\)/.exec(preset)?.[1];
    expect(mediumFps).toBeDefined();
    expect(integration).toContain(`const ANDROID_VIDEO_SERVER_MEDIUM_FPS = ${mediumFps};`);
  });
});
