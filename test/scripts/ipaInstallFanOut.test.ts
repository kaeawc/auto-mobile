import { describe, expect, test } from "bun:test";
import { indexOfNamed, indexOfWaitOn, loadJobSteps, stepNamed } from "../helpers/workflowSteps";

// Guards issue #4127: `build-ctrl-proxy-ios-ipa.yml` ran its tool installs
// serially. Both are network I/O and independent of the simulator-runtime
// ensure, so they now run backgrounded and re-sync at one barrier before the
// build. High leverage — this reusable workflow is called by nightly.yml,
// release.yml and prepare-release.yml.
//
// Two constraints make the ordering load-bearing rather than cosmetic:
//
//  1. `gem install xcpretty` writes ~/.gem, so it must stay AFTER
//     `Cache Ruby gems`. It may be backgrounded, but never hoisted above the
//     cache restore.
//  2. The barrier prevents corruption, not just mis-ordering:
//     ctrl-proxy-create-ipa.sh re-invokes install-xcodegen.sh, and
//     install-xcodegen.sh documents the concurrent-prefix race that causes
//     ("File exists", nested share/xcodegen/xcodegen/) when two installs run
//     against one prefix. Without the wait, the backgrounded install races the
//     build's own invocation.

const WORKFLOW = ".github/workflows/build-ctrl-proxy-ios-ipa.yml";
const JOB_ID = "build";

const XCODEGEN_STEP = "Install XcodeGen";
const XCODEGEN_ID = "install-xcodegen";
const XCPRETTY_STEP = "Install xcpretty";
const XCPRETTY_ID = "install-xcpretty";
const CACHE_STEP = "Cache Ruby gems";
const RUNTIME_STEP = "Ensure iOS Simulator runtime";
const BUILD_STEP = "Build CtrlProxy iOS IPA";

const steps = loadJobSteps(WORKFLOW, JOB_ID);

describe("#4127 CtrlProxy IPA install fan-out", () => {
  // Without this, a renamed job would leave `steps` empty and every ordering
  // assertion below would pass vacuously.
  test("the build job exists and has steps", () => {
    expect(steps.length).toBeGreaterThan(0);
  });

  test("both installs are backgrounded and carry their ids", () => {
    const xcodegen = stepNamed(steps, XCODEGEN_STEP);
    expect(xcodegen).toBeDefined();
    expect(xcodegen?.background).toBe(true);
    expect(xcodegen?.id).toBe(XCODEGEN_ID);

    const xcpretty = stepNamed(steps, XCPRETTY_STEP);
    expect(xcpretty).toBeDefined();
    expect(xcpretty?.background).toBe(true);
    expect(xcpretty?.id).toBe(XCPRETTY_ID);
  });

  test("the XcodeGen install starts before the gem cache and runtime ensure", () => {
    const xcodegenIndex = indexOfNamed(steps, XCODEGEN_STEP);
    const cacheIndex = indexOfNamed(steps, CACHE_STEP);
    const runtimeIndex = indexOfNamed(steps, RUNTIME_STEP);

    expect(xcodegenIndex).toBeGreaterThanOrEqual(0);
    expect(cacheIndex).toBeGreaterThanOrEqual(0);
    expect(runtimeIndex).toBeGreaterThanOrEqual(0);

    expect(xcodegenIndex).toBeLessThan(cacheIndex);
    expect(xcodegenIndex).toBeLessThan(runtimeIndex);
  });

  test("the xcpretty install stays after the gem cache but still overlaps the runtime ensure", () => {
    // Constraint 1: `gem install` writes ~/.gem, which the cache restores.
    // Backgrounding it is fine; hoisting it above the cache is not.
    const xcprettyIndex = indexOfNamed(steps, XCPRETTY_STEP);
    const cacheIndex = indexOfNamed(steps, CACHE_STEP);
    const runtimeIndex = indexOfNamed(steps, RUNTIME_STEP);

    expect(xcprettyIndex).toBeGreaterThan(cacheIndex);
    expect(xcprettyIndex).toBeLessThan(runtimeIndex);
  });

  test("one barrier covers both installs and precedes the build", () => {
    // Constraint 2: the build re-invokes install-xcodegen.sh, so the wait must
    // land before it or the two installs corrupt the shared prefix.
    const waitXcodegen = indexOfWaitOn(steps, XCODEGEN_ID);
    const waitXcpretty = indexOfWaitOn(steps, XCPRETTY_ID);
    const buildIndex = indexOfNamed(steps, BUILD_STEP);

    expect(waitXcodegen).toBeGreaterThanOrEqual(0);
    expect(waitXcpretty).toBeGreaterThanOrEqual(0);
    // A single list barrier, not two separate ones.
    expect(waitXcodegen).toBe(waitXcpretty);

    expect(buildIndex).toBeGreaterThanOrEqual(0);
    expect(waitXcodegen).toBeLessThan(buildIndex);
  });

  test("Xcode selection still precedes the simulator runtime ensure", () => {
    // The runtime ensure resolves against the selected toolchain, so the
    // reorder must not float it above `Select Xcode 26.5`.
    const selectIndex = indexOfNamed(steps, "Select Xcode 26.5");
    const runtimeIndex = indexOfNamed(steps, RUNTIME_STEP);

    expect(selectIndex).toBeGreaterThanOrEqual(0);
    expect(selectIndex).toBeLessThan(runtimeIndex);
  });
});
