import { FakeTimer } from "../../fakes/FakeTimer";
import { templateName } from "../../../src/utils/ios-cmdline-tools/SimulatorTemplateKey";
import { getAbortSignal, runWithAbortSignal } from "../../../src/utils/AbortContext";
import { expect, test } from "bun:test";
import { SimulatorTemplateBuilder } from "../../../src/features/iosTemplates/SimulatorTemplateBuilder";
import { SimulatorTemplateBuildHarness } from "../../helpers/SimulatorTemplateBuildHarness";
const key = {
  runtime: "ios",
  runtimeBuild: "R1",
  xcodeBuild: "X1",
  deviceType: "phone",
  profile: "none" as const,
};
test("build orders lock, profile, admission, settle and verified shutdown before publication", async () => {
  const fake = new SimulatorTemplateBuildHarness();
  expect(await new SimulatorTemplateBuilder(fake.dependencies()).build(key)).toBe("ready");
  expect(fake.events).toEqual([
    "lock",
    "verify",
    "building",
    "create",
    "building",
    "apply",
    "admit:create",
    "boot",
    "settle",
    "shutdown",
    "verify",
    "ready",
    "release",
  ]);
});
test("capacity refusal is retryable and not failed", async () => {
  const fake = new SimulatorTemplateBuildHarness();
  fake.refuse = true;
  expect(await new SimulatorTemplateBuilder(fake.dependencies()).build(key)).toBe("retry later");
  expect(fake.manifest?.state).toBe("stale");
  expect(fake.manifest?.failure).toBeUndefined();
  expect(fake.events).toContain("delete");
  expect(fake.events.at(-1)).toBe("release");
});
test("settle timeout deletes partial template and backs off", async () => {
  const fake = new SimulatorTemplateBuildHarness();
  fake.settleFails = true;
  const builder = new SimulatorTemplateBuilder(fake.dependencies());
  expect(await builder.build(key)).toBe("failed");
  expect(fake.manifest?.nextAttemptAtMs).toBe(60_000);
  expect(await builder.build(key)).toBe("retry later");
  expect(fake.events.filter((event) => event === "create")).toHaveLength(1);
});
test("lock elsewhere returns without creating", async () => {
  const fake = new SimulatorTemplateBuildHarness();
  fake.locked = true;
  expect(await new SimulatorTemplateBuilder(fake.dependencies()).build(key)).toBe(
    "building elsewhere",
  );
  expect(fake.events).toEqual(["lock"]);
});
test("abort after create deletes half template and releases lock", async () => {
  const fake = new SimulatorTemplateBuildHarness();
  const abort = new AbortController();
  fake.afterCreate = () => abort.abort();
  expect(await new SimulatorTemplateBuilder(fake.dependencies()).build(key, abort.signal)).toBe(
    "failed",
  );
  expect(fake.events).toContain("delete");
  expect(fake.events.at(-1)).toBe("release");
});

test("abort cleanup runs outside the cancelled ambient request", async () => {
  const fake = new SimulatorTemplateBuildHarness();
  const abort = new AbortController();
  fake.afterCreate = () => abort.abort();
  const deps = fake.dependencies();
  deps.client.deleteSimulator = async () => {
    expect(getAbortSignal()).toBeUndefined();
    fake.events.push("delete");
  };
  await runWithAbortSignal(abort.signal, () =>
    new SimulatorTemplateBuilder(deps).build(key, abort.signal),
  );
  expect(fake.events).toContain("delete");
});
test("profile application failure cannot publish a lean template", async () => {
  const fake = new SimulatorTemplateBuildHarness();
  const deps = fake.dependencies();
  deps.profile = () => ({
    apply: async () => ({ applied: false, resources: [], labels: [], reason: "denied" }),
  });
  expect(await new SimulatorTemplateBuilder(deps).build({ ...key, profile: "minimal" })).toBe(
    "failed",
  );
  expect(fake.events).not.toContain("boot");
  expect(fake.events.at(-1)).toBe("release");
});
test("runtime build changed before background build defers without creating", async () => {
  const fake = new SimulatorTemplateBuildHarness();
  expect(
    await new SimulatorTemplateBuilder(fake.dependencies()).build({ ...key, runtimeBuild: "old" }),
  ).toBe("retry later");
  expect(fake.events).toEqual(["lock", "release"]);
});

test("attempts escalate with FakeTimer and reset after a successful retry", async () => {
  const fake = new SimulatorTemplateBuildHarness();
  fake.settleFails = true;
  const deps = fake.dependencies();
  const builder = new SimulatorTemplateBuilder(deps);
  for (const [attempt, delay] of [
    [1, 60_000],
    [2, 120_000],
    [3, 240_000],
  ]) {
    expect(await builder.build(key)).toBe("failed");
    expect(fake.manifest?.attempt).toBe(attempt);
    expect(fake.manifest?.nextAttemptAtMs).toBe(deps.timer.now() + delay);
    expect(await builder.build(key)).toBe("retry later");
    (deps.timer as FakeTimer).advanceTime(delay);
  }
  fake.settleFails = false;
  expect(await builder.build(key)).toBe("ready");
  expect(fake.manifest?.attempt).toBe(0);
});
test("capacity precheck skips without creating a failed manifest", async () => {
  const fake = new SimulatorTemplateBuildHarness();
  const deps = fake.dependencies();
  deps.hasSpareCapacity = async () => false;
  expect(await new SimulatorTemplateBuilder(deps).build(key)).toBe("retry later");
  expect(fake.manifest).toBeUndefined();
  expect(fake.events).toEqual(["lock", "release"]);
});
test("crash leftover with the exact key name is deleted under the lock before create", async () => {
  const fake = new SimulatorTemplateBuildHarness();
  fake.present = true;
  fake.name = templateName(key);
  expect(await new SimulatorTemplateBuilder(fake.dependencies()).build(key)).toBe("ready");
  expect(fake.events.indexOf("delete")).toBeGreaterThan(fake.events.indexOf("lock"));
  expect(fake.events.indexOf("delete")).toBeLessThan(fake.events.indexOf("create"));
});
