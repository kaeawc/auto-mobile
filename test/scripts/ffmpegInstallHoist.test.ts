import { describe, expect, test } from "bun:test";
import { indexOfNamed, indexOfWaitOn, loadJobSteps, stepNamed } from "../helpers/workflowSteps";

// Guards issue #4124: `ios-xctest-runner-simulator-tests` used to install FFmpeg
// *inside* the videoRecording test step:
//
//     - name: "Run videoRecording MP4 integration test"
//       timeout-minutes: 10
//       run: |
//         brew list ffmpeg >/dev/null 2>&1 || brew install ffmpeg
//         ./scripts/ios/video-recording-start-stop-integration.sh
//
// That charged a cold `brew install ffmpeg` (a large formula tree) against the
// step's own 10-minute cap AND the test's internal 180s budget, on a step that
// is a known intermittent timeout. The fix backgrounds the install with the
// existing XcodeGen/xcpretty fan-out so it overlaps the simulator boot, then
// re-syncs with a `wait` barrier before the test.
//
// The workflow is parsed as YAML rather than line-matched, so these assertions
// pin the job's actual `steps` semantics — a comment, a reflow, or text inside
// some other step's block scalar can neither satisfy nor break them.

const WORKFLOW = ".github/workflows/pull_request.yml";
const JOB_ID = "ios-xctest-runner-simulator-tests";

const steps = loadJobSteps(WORKFLOW, JOB_ID);

describe("#4124 ffmpeg install hoist", () => {
  // If the job is ever renamed, every other assertion would vacuously pass
  // against an empty step list. Fail loudly instead.
  test("the job under test exists and has steps", () => {
    expect(steps.length).toBeGreaterThan(0);
  });

  test("the ffmpeg install is a backgrounded step carrying the install-ffmpeg id", () => {
    const install = stepNamed(steps, "Install ffmpeg");
    expect(install).toBeDefined();
    expect(install?.background).toBe(true);
    expect(install?.id).toBe("install-ffmpeg");
  });

  test("the ffmpeg install starts before the CtrlProxy UI simulator boot", () => {
    // AC1: it must run concurrently with the boot, so it has to be started
    // earlier in the step list than the boot it overlaps.
    const installIndex = indexOfNamed(steps, "Install ffmpeg");
    const bootIndex = indexOfNamed(steps, "Boot iOS Simulator for CtrlProxy UI tests (Xcode 26.5)");

    expect(installIndex).toBeGreaterThanOrEqual(0);
    expect(bootIndex).toBeGreaterThanOrEqual(0);
    expect(installIndex).toBeLessThan(bootIndex);
  });

  test("a wait barrier on install-ffmpeg precedes the videoRecording test", () => {
    // AC1: without the barrier the test could start before ffmpeg finished
    // installing — the exact failure backgrounding would otherwise introduce.
    const waitIndex = indexOfWaitOn(steps, "install-ffmpeg");
    const testIndex = indexOfNamed(steps, "Run videoRecording MP4 integration test");

    expect(waitIndex).toBeGreaterThanOrEqual(0);
    expect(testIndex).toBeGreaterThanOrEqual(0);
    expect(waitIndex).toBeLessThan(testIndex);
  });

  test("the videoRecording test step no longer installs ffmpeg inline", () => {
    // AC2: the step's 10-minute budget must cover the test alone.
    const videoStep = stepNamed(steps, "Run videoRecording MP4 integration test");
    expect(videoStep).toBeDefined();
    expect(videoStep?.run).toBeDefined();
    expect(videoStep?.run).not.toContain("brew");
    expect(videoStep?.run).toContain("video-recording-start-stop-integration.sh");
  });

  test("advanced iOS integrations opt in without widening the default tool surface", () => {
    const videoStep = stepNamed(steps, "Run videoRecording MP4 integration test");
    const daemonStep = stepNamed(steps, "Ensure AutoMobile daemon ready (Xcode 26.5)");
    const navigationStep = stepNamed(steps, "Run iOS navigation graph Simulator workflow");

    expect(videoStep?.env?.AUTOMOBILE_TOOLSET_SCREEN_ARTIFACTS).toBe("1");
    expect(daemonStep?.env?.AUTOMOBILE_TOOLSET_NAVIGATION_MODELING).toBe("1");
    expect(navigationStep?.env?.AUTOMOBILE_TOOLSET_NAVIGATION_MODELING).toBe("1");
  });
});
