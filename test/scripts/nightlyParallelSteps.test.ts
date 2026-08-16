import { describe, expect, test } from "bun:test";
import { indexOfNamed, indexOfWaitOn, loadJobSteps, stepNamed } from "../helpers/workflowSteps";

// Guards issue #4128: three independent wins in nightly.yml.
//
//  5a `ios-xctest-runner-simulator-tests` — `gem install xcpretty` is network
//     I/O and its only consumer is ctrl-proxy-build-for-testing.sh (which pipes
//     to xcpretty). Background it and hoist the npm-package setup above the
//     build so both overlap it, then re-sync before the build.
//  5b `ios-xcode-build-sweep` — the XcodeGen install is network I/O and the
//     simulator-runtime ensure never touches xcodegen, so they overlap. The
//     barrier MUST precede `Generate Xcode Projects`: both
//     xcodegen-generate.sh and xcode-build.sh re-invoke install-xcodegen.sh,
//     and concurrent installs against one prefix are a documented corruption
//     race ("File exists", nested share/xcodegen/xcodegen/).
//  5c the standalone `Setup Bun` step was redundant —
//     setup-auto-mobile-npm-package already runs oven-sh/setup-bun@v2 at the
//     same pinned 1.3.9.

const WORKFLOW = ".github/workflows/nightly.yml";

describe("#4128 nightly — XcodeGen overlap in ios-xcode-build-sweep", () => {
  const steps = loadJobSteps(WORKFLOW, "ios-xcode-build-sweep");

  test("the job exists and has steps", () => {
    expect(steps.length).toBeGreaterThan(0);
  });

  test("the XcodeGen install is backgrounded and carries its id", () => {
    const install = stepNamed(steps, "Install XcodeGen");
    expect(install).toBeDefined();
    expect(install?.background).toBe(true);
    expect(install?.id).toBe("install-xcodegen");
  });

  test("the simulator runtime ensure is hoisted up to overlap the install", () => {
    const installIndex = indexOfNamed(steps, "Install XcodeGen");
    const runtimeIndex = indexOfNamed(steps, "Ensure iOS Simulator runtime");
    const generateIndex = indexOfNamed(steps, "Generate Xcode Projects");

    expect(installIndex).toBeGreaterThanOrEqual(0);
    expect(runtimeIndex).toBeGreaterThanOrEqual(0);
    expect(generateIndex).toBeGreaterThanOrEqual(0);

    expect(installIndex).toBeLessThan(runtimeIndex);
    expect(runtimeIndex).toBeLessThan(generateIndex);
  });

  test("the barrier precedes Generate Xcode Projects, not just the build", () => {
    // Load-bearing: xcodegen-generate.sh AND xcode-build.sh each re-invoke
    // install-xcodegen.sh. Waiting only before `Build Xcode Projects` would
    // still let the generate step race the backgrounded install.
    const waitIndex = indexOfWaitOn(steps, "install-xcodegen");
    const generateIndex = indexOfNamed(steps, "Generate Xcode Projects");
    const buildIndex = indexOfNamed(steps, "Build Xcode Projects");

    expect(waitIndex).toBeGreaterThanOrEqual(0);
    expect(waitIndex).toBeLessThan(generateIndex);
    expect(generateIndex).toBeLessThan(buildIndex);
  });
});
