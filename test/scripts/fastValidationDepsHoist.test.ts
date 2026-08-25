import { describe, expect, test } from "bun:test";
import {
  indexOfNamed,
  indexOfUses,
  indexOfWaitOn,
  loadJobSteps,
  stepNamed,
} from "../helpers/workflowSteps";

// Guards issue #4125: in `fast-validation` the apt/bats dependency install ran
// serially *after* two slow setup steps it does not depend on —
// `Set up JDK` (a download) and `setup-auto-mobile-npm-package`
// (Bun + ripgrep + `bun install` + build, ~60-120s). The install is pure
// network/disk (~30-60s), so it now runs backgrounded from just after checkout
// and re-syncs at a `wait` barrier before its first consumer.
//
// `Fast Validation` is a required check, so a misplaced barrier would break
// every PR: the ordering below is the guard against that.

const WORKFLOW = ".github/workflows/pull_request.yml";
const JOB_ID = "fast-validation";
const INSTALL_STEP = "Install fast validation dependencies";
const INSTALL_ID = "install-fast-validation-deps";

const steps = loadJobSteps(WORKFLOW, JOB_ID);

describe("#4125 fast-validation dependency install hoist", () => {
  // Without this, a renamed job would leave `steps` empty and every ordering
  // assertion below would pass vacuously.
  test("the job under test exists and has steps", () => {
    expect(steps.length).toBeGreaterThan(0);
  });

  test("the dependency install is backgrounded and carries its id", () => {
    const install = stepNamed(steps, INSTALL_STEP);
    expect(install).toBeDefined();
    expect(install?.background).toBe(true);
    expect(install?.id).toBe(INSTALL_ID);
  });

  test("the install starts before the JDK and npm-package setup it overlaps", () => {
    // AC1: to run concurrently with them it must be started earlier in the list.
    const installIndex = indexOfNamed(steps, INSTALL_STEP);
    const jdkIndex = indexOfNamed(steps, "Set up JDK");
    const npmPackageIndex = indexOfUses(steps, "./.github/actions/setup-auto-mobile-npm-package");

    expect(installIndex).toBeGreaterThanOrEqual(0);
    expect(jdkIndex).toBeGreaterThanOrEqual(0);
    expect(npmPackageIndex).toBeGreaterThanOrEqual(0);

    expect(installIndex).toBeLessThan(jdkIndex);
    expect(installIndex).toBeLessThan(npmPackageIndex);
  });

  test("the wait barrier precedes the fast validation checks", () => {
    // AC2: the aggregator's `xml` check shells out to xmlstarlet, which comes
    // from the backgrounded install, so the barrier must sit before it. (The
    // Ubuntu BATS pass that also consumed this install now runs in the parallel
    // `bats-tests` matrix job, not inline here.)
    const waitIndex = indexOfWaitOn(steps, INSTALL_ID);
    const checksIndex = indexOfNamed(steps, "Run fast validation checks");

    expect(waitIndex).toBeGreaterThanOrEqual(0);
    expect(checksIndex).toBeGreaterThanOrEqual(0);

    expect(waitIndex).toBeLessThan(checksIndex);
  });

  test("the JDK setup still precedes the checks that need it", () => {
    // The JDK is pinned so the ktfmt check inside `Run fast validation checks`
    // formats deterministically. Hoisting the install must not reorder that.
    const jdkIndex = indexOfNamed(steps, "Set up JDK");
    const checksIndex = indexOfNamed(steps, "Run fast validation checks");

    expect(jdkIndex).toBeGreaterThanOrEqual(0);
    expect(jdkIndex).toBeLessThan(checksIndex);
  });
});
