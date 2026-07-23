import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CAPTURE_STAGES } from "../helpers/captureStageTimeline";

const repoRoot = join(import.meta.dir, "../..");

function read(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf8");
}

const INTEGRATION_TEST_PATH = "test/integration/webrtcDeviceCapture.integration.test.ts";

/** Source with comments stripped, so a commented-out call cannot satisfy a guard. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * Index of `needle`, asserted present first. A bare `indexOf` returns -1 when
 * the call site is deleted outright, and -1 satisfies any "comes before" check —
 * so an ordering guard built on it passes precisely when the code is gone.
 */
function indexOfRequired(source: string, needle: string): number {
  const index = source.indexOf(needle);
  expect(`${needle} present: ${index >= 0}`).toBe(`${needle} present: true`);
  return index;
}

/**
 * The device lane needs a real emulator/simulator, so its instrumentation
 * cannot be exercised here. These guards pin the wiring instead: every stage is
 * marked in pipeline order, each stage measures the event it is named for, the
 * record survives a timeout, and no assertion depends on how long a hosted
 * runner happened to take (#4343).
 */
describe("#4343 device capture latency instrumentation", () => {
  test("marks every capture-to-browser stage, in pipeline order", () => {
    const source = withoutComments(read(INTEGRATION_TEST_PATH));
    const positions = CAPTURE_STAGES.map(stage => source.indexOf(`timeline.mark("${stage}")`));

    for (const [index, position] of positions.entries()) {
      expect(`${CAPTURE_STAGES[index]}:${position >= 0}`).toBe(`${CAPTURE_STAGES[index]}:true`);
    }
    // A mark that moved out of its pipeline position would still be "present",
    // so pin the order the call sites appear in as well.
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });

  test("takes source-started from the daemon rather than from the start response", () => {
    const source = withoutComments(read(INTEGRATION_TEST_PATH));

    // The stream descriptor's own signal — a video-only start returns before
    // capture begins, so the start response cannot stand in for it.
    expect(source).toContain("sourceStarted === true");
    expect(indexOfRequired(source, 'timeline.mark("sourceStarted")')).toBeLessThan(
      indexOfRequired(source, 'action: "start"')
    );
  });

  test("launches the browser before the measured window opens", () => {
    const source = withoutComments(read(INTEGRATION_TEST_PATH));

    // Chrome cold start is seconds on a hosted runner; inside the window it
    // would land in the WHEP-connect stage and dominate it.
    // Match the call sites, not the declarations of `chromeBinary`/`launchReader`
    // — those sit at the top of the file and would satisfy any ordering check.
    const startRequestIndex = indexOfRequired(source, 'timeline.mark("startRequest")');
    expect(indexOfRequired(source, "chrome = start(chromeBinary()")).toBeLessThan(startRequestIndex);
    expect(indexOfRequired(source, "cdp = await launchReader()")).toBeLessThan(startRequestIndex);
  });

  test("writes the latency record from afterAll so a timed-out run still reports", () => {
    const source = withoutComments(read(INTEGRATION_TEST_PATH));
    const afterAllIndex = source.indexOf("afterAll(");

    // bun skips the test body's `finally` when the deadline fires but still runs
    // afterAll, so writing from the body would drop exactly the slowest samples.
    expect(afterAllIndex).toBeGreaterThan(0);
    expect(source.indexOf("afterAll(", afterAllIndex + 1)).toBe(-1);
    expect(source.indexOf("stage-latency.json")).toBeGreaterThan(afterAllIndex);
    expect(source.indexOf("result.txt")).toBeGreaterThan(afterAllIndex);
  });

  test("prints the formatted record so a passing CI run reports its timings", () => {
    const source = withoutComments(read(INTEGRATION_TEST_PATH));

    expect(source).toContain("console.log(`[#4343] device capture stage latency");
  });

  test("asserts nothing about measured durations", () => {
    // Collapsed so a multi-line expect() cannot slip past a line-scoped scan.
    // An assertion on a variable aliasing a timing value would still evade this;
    // the guard covers direct use, which is how such an assertion gets written.
    const collapsed = withoutComments(read(INTEGRATION_TEST_PATH)).replace(/\s+/g, " ");
    const assertions = collapsed.match(/expect\([^;]*?\)\s*\.[a-zA-Z]+\(/g) ?? [];

    expect(assertions.length).toBeGreaterThan(0);
    expect(
      assertions.filter(assertion =>
        /timeline|record|elapsedMs|deltaMs|captureToBrowserMs|latency/.test(assertion)
      )
    ).toEqual([]);
  });

  test("mirrors the Android capture fps from the video-server default quality preset", () => {
    const integration = read(INTEGRATION_TEST_PATH);
    const encoder = read("src/features/webrtc/PersistentEncoderH264Source.ts");
    const preset = read(
      "android/video-server/src/main/kotlin/dev/jasonpearson/automobile/video/QualityPreset.kt"
    );

    // The lane runs the persistent encoder, which sends `--quality medium`.
    expect(encoder).toContain('this.options.quality ?? "medium"');
    // Sliced rather than matched in one regex so a ktfmt reflow or an argument
    // reorder inside MEDIUM(...) does not turn a formatting change into a
    // spurious failure here.
    const medium = /MEDIUM\(([\s\S]*?)\)/.exec(preset)?.[1];
    expect(medium).toBeDefined();
    const mediumFps = /fps\s*=\s*(\d+)/.exec(medium ?? "")?.[1];
    expect(mediumFps).toBeDefined();
    expect(integration).toContain(`const ANDROID_VIDEO_SERVER_MEDIUM_FPS = ${mediumFps};`);
  });
});
