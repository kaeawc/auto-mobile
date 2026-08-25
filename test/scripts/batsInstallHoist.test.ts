import { describe, expect, test } from "bun:test";
import { indexOfNamed, indexOfWaitOn, loadJobSteps, stepNamed } from "../helpers/workflowSteps";

// Guards issue #4126: the `bats-tests` job installed BATS serially after the Bun
// setup, even though the two are independent. `Install BATS` is
// `brew install bats-core` on macOS (tens of seconds) or a `git clone` +
// source install on Linux — pure network/disk — while `install-bun-deps.sh`
// only runs `bun install --frozen-lockfile` into `node_modules`. Disjoint
// targets, and `bats test/bats/` is the sole consumer of both.
//
// The install is now backgrounded from just after checkout and re-synced at a
// `wait` barrier before the test step. `BATS Shell Tests (macos-latest)` is a
// required check, so the barrier placement is pinned here rather than left to
// review.
//
// Scoped by job id, which matters: the `bats-tests` job now runs the suite on
// both ubuntu-latest and macos-latest (the Ubuntu pass used to run inline inside
// `fast-validation`), and a whole-file search could conflate jobs.

const JOB_ID = "bats-tests";
const INSTALL_STEP = "Install BATS";
const INSTALL_ID = "install-bats";
const CONSUMER_STEP = "Run BATS Tests";

const WORKFLOWS = [
  { label: "pull_request.yml", path: ".github/workflows/pull_request.yml" },
  { label: "merge.yml", path: ".github/workflows/merge.yml" },
];

for (const workflow of WORKFLOWS) {
  describe(`#4126 BATS install hoist (${workflow.label})`, () => {
    const steps = loadJobSteps(workflow.path, JOB_ID);

    // Without this, a renamed job would leave `steps` empty and every ordering
    // assertion below would pass vacuously.
    test("the bats-tests job exists and has steps", () => {
      expect(steps.length).toBeGreaterThan(0);
    });

    test("the BATS install is backgrounded and carries its id", () => {
      const install = stepNamed(steps, INSTALL_STEP);
      expect(install).toBeDefined();
      expect(install?.background).toBe(true);
      expect(install?.id).toBe(INSTALL_ID);
    });

    test("the BATS install starts before the Bun setup it overlaps", () => {
      // AC1: to run concurrently with them it must be started earlier in the list.
      const installIndex = indexOfNamed(steps, INSTALL_STEP);
      const setupBunIndex = indexOfNamed(steps, "Setup Bun");
      const bunDepsIndex = indexOfNamed(steps, "Install Bun dependencies");

      expect(installIndex).toBeGreaterThanOrEqual(0);
      expect(setupBunIndex).toBeGreaterThanOrEqual(0);
      expect(bunDepsIndex).toBeGreaterThanOrEqual(0);

      expect(installIndex).toBeLessThan(setupBunIndex);
      expect(installIndex).toBeLessThan(bunDepsIndex);
    });

    test("the wait barrier precedes the BATS test step", () => {
      // AC2: without it the suite could start before bats finished installing.
      const waitIndex = indexOfWaitOn(steps, INSTALL_ID);
      const consumerIndex = indexOfNamed(steps, CONSUMER_STEP);

      expect(waitIndex).toBeGreaterThanOrEqual(0);
      expect(consumerIndex).toBeGreaterThanOrEqual(0);
      expect(waitIndex).toBeLessThan(consumerIndex);
    });

    test("install-bun-deps still precedes the test step (it writes GITHUB_PATH)", () => {
      // `install-bun-deps.sh` appends node_modules/.bin to $GITHUB_PATH, so it
      // must stay in the foreground ahead of the consumer — hoisting the BATS
      // install must not reorder it past the tests.
      const bunDepsIndex = indexOfNamed(steps, "Install Bun dependencies");
      const consumerIndex = indexOfNamed(steps, CONSUMER_STEP);

      expect(bunDepsIndex).toBeGreaterThanOrEqual(0);
      expect(bunDepsIndex).toBeLessThan(consumerIndex);
    });

    test("the suite runs through the parallel runner, not a bare serial `bats`", () => {
      // The ~900-test suite runs cross-file-parallel via scripts/ci/run-bats.sh.
      // Guard against a regression back to serial `bats test/bats/`, which is
      // what dominated the required "Shell Tests" gate's wall-clock.
      const consumer = stepNamed(steps, CONSUMER_STEP);
      expect(consumer?.run).toContain("scripts/ci/run-bats.sh");
      expect(consumer?.run).not.toContain("bats test/bats/");
    });
  });
}
