import { describe, expect, test } from "bun:test";
import {
  indexOfNamed,
  indexOfUses,
  indexOfWaitOn,
  loadJobSteps,
  stepNamed,
} from "../helpers/workflowSteps";

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
const NPM_PACKAGE_ACTION = "./.github/actions/setup-auto-mobile-npm-package";

describe("#4128 nightly — xcpretty overlap in ios-xctest-runner-simulator-tests", () => {
  const steps = loadJobSteps(WORKFLOW, "ios-xctest-runner-simulator-tests");

  test("the job exists and has steps", () => {
    expect(steps.length).toBeGreaterThan(0);
  });

  test("the xcpretty install is backgrounded and carries its id", () => {
    const install = stepNamed(steps, "Install xcpretty");
    expect(install).toBeDefined();
    expect(install?.background).toBe(true);
    expect(install?.id).toBe("install-xcpretty");
  });

  test("the npm-package setup is hoisted above the build so it overlaps the install", () => {
    const installIndex = indexOfNamed(steps, "Install xcpretty");
    const npmIndex = indexOfUses(steps, NPM_PACKAGE_ACTION);
    const buildIndex = indexOfNamed(steps, "Build CtrlProxy iOS for Testing");

    expect(installIndex).toBeGreaterThanOrEqual(0);
    expect(npmIndex).toBeGreaterThanOrEqual(0);
    expect(buildIndex).toBeGreaterThanOrEqual(0);

    expect(installIndex).toBeLessThan(npmIndex);
    expect(npmIndex).toBeLessThan(buildIndex);
  });

  test("the wait barrier precedes the CtrlProxy build, xcpretty's only consumer", () => {
    const waitIndex = indexOfWaitOn(steps, "install-xcpretty");
    const buildIndex = indexOfNamed(steps, "Build CtrlProxy iOS for Testing");

    expect(waitIndex).toBeGreaterThanOrEqual(0);
    expect(waitIndex).toBeLessThan(buildIndex);
  });

  test("the artifact verification still follows the build that produces them", () => {
    const buildIndex = indexOfNamed(steps, "Build CtrlProxy iOS for Testing");
    const verifyIndex = indexOfNamed(steps, "Verify CtrlProxy iOS Artifacts");

    expect(verifyIndex).toBeGreaterThanOrEqual(0);
    expect(buildIndex).toBeLessThan(verifyIndex);
  });

  test("the redundant standalone Setup Bun step is gone", () => {
    // 5c: setup-auto-mobile-npm-package already runs setup-bun at the same
    // pinned version, so a second standalone step is pure duplication.
    expect(stepNamed(steps, "Setup Bun")).toBeUndefined();
    // ...but Bun must still be provisioned, via the composite.
    expect(indexOfUses(steps, NPM_PACKAGE_ACTION)).toBeGreaterThanOrEqual(0);
  });
});

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
