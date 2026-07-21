import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";

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

const repoRoot = join(import.meta.dir, "../..");
const workflowPath = join(repoRoot, ".github/workflows/pull_request.yml");
const JOB_ID = "ios-xctest-runner-simulator-tests";

interface WorkflowStep {
  name?: string;
  id?: string;
  run?: string;
  background?: boolean;
  wait?: string | string[];
}

const workflow = load(readFileSync(workflowPath, "utf8")) as {
  jobs: Record<string, { steps: WorkflowStep[] }>;
};
const steps: WorkflowStep[] = workflow.jobs?.[JOB_ID]?.steps ?? [];

const indexOfNamed = (name: string): number => steps.findIndex(s => s.name === name);
const stepNamed = (name: string): WorkflowStep | undefined => steps.find(s => s.name === name);

// A `wait` step carries no name, so match on the barrier's target id. `wait`
// accepts a single id or a list, so normalize before comparing.
const indexOfWaitOn = (id: string): number =>
  steps.findIndex(s => {
    if (s.wait === undefined) {
      return false;
    }
    return (Array.isArray(s.wait) ? s.wait : [s.wait]).includes(id);
  });

describe("#4124 ffmpeg install hoist", () => {
  // If the job is ever renamed, every other assertion would vacuously pass
  // against an empty step list. Fail loudly instead.
  test("the job under test exists and has steps", () => {
    expect(steps.length).toBeGreaterThan(0);
  });

  test("the ffmpeg install is a backgrounded step carrying the install-ffmpeg id", () => {
    const install = stepNamed("Install ffmpeg");
    expect(install).toBeDefined();
    expect(install?.background).toBe(true);
    expect(install?.id).toBe("install-ffmpeg");
  });

  test("the ffmpeg install starts before the Xcode 26.5 simulator boot", () => {
    // AC1: it must run concurrently with the boot, so it has to be started
    // earlier in the step list than the boot it overlaps.
    const installIndex = indexOfNamed("Install ffmpeg");
    const bootIndex = indexOfNamed("Boot iOS Simulator (Xcode 26.5)");

    expect(installIndex).toBeGreaterThanOrEqual(0);
    expect(bootIndex).toBeGreaterThanOrEqual(0);
    expect(installIndex).toBeLessThan(bootIndex);
  });

  test("a wait barrier on install-ffmpeg precedes the videoRecording test", () => {
    // AC1: without the barrier the test could start before ffmpeg finished
    // installing — the exact failure backgrounding would otherwise introduce.
    const waitIndex = indexOfWaitOn("install-ffmpeg");
    const testIndex = indexOfNamed("Run videoRecording MP4 integration test");

    expect(waitIndex).toBeGreaterThanOrEqual(0);
    expect(testIndex).toBeGreaterThanOrEqual(0);
    expect(waitIndex).toBeLessThan(testIndex);
  });

  test("the videoRecording test step no longer installs ffmpeg inline", () => {
    // AC2: the step's 10-minute budget must cover the test alone.
    const videoStep = stepNamed("Run videoRecording MP4 integration test");
    expect(videoStep).toBeDefined();
    expect(videoStep?.run).toBeDefined();
    expect(videoStep?.run).not.toContain("brew");
    expect(videoStep?.run).toContain("video-recording-start-stop-integration.sh");
  });
});
