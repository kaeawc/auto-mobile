import { join } from "node:path";
import { expect, test } from "bun:test";
import { FileSimulatorTemplateLock } from "../../../src/features/iosTemplates/SimulatorTemplateLock";
import { templateKeyHash } from "../../../src/utils/ios-cmdline-tools/SimulatorTemplateKey";
import { FakeLockFileSystem } from "../../fakes/FakeLockFileSystem";
import { FakeLockOwnerGenerationProbe } from "../../fakes/FakeLockOwnerGenerationProbe";
import { FakeIdGenerator } from "../../fakes/FakeIdGenerator";
import { FakeTimer } from "../../fakes/FakeTimer";
const key = {
  runtime: "ios",
  runtimeBuild: "R1",
  xcodeBuild: "X1",
  deviceType: "phone",
  profile: "none" as const,
};
function rig() {
  const timer = new FakeTimer();
  const fs = new FakeLockFileSystem(() => timer.now());
  const lock = new FileSimulatorTemplateLock(timer, () => "/templates", {
    fileSystem: fs,
    pid: 42,
    isProcessRunning: (pid) => pid === 42,
    ownerGeneration: new FakeLockOwnerGenerationProbe(),
    idGenerator: new FakeIdGenerator(),
    now: () => timer.now(),
  });
  return { lock, fs, path: join("/templates", `${templateKeyHash(key)}.lock`) };
}
test("stale holder is reclaimed and released", async () => {
  const { lock, fs, path } = rig();
  fs.seed(path, "99");
  const release = await lock.acquire(key);
  expect(release).toBeDefined();
  release?.();
  expect(fs.exists(path)).toBe(false);
});
test("live holder refuses acquisition", async () => {
  const { lock, fs, path } = rig();
  fs.seed(path, "42");
  expect(await lock.acquire(key)).toBeUndefined();
});
test("in-process acquisition is exclusive and release permits reuse", async () => {
  const { lock } = rig();
  const first = await lock.acquire(key);
  expect(first).toBeDefined();
  expect(await lock.acquire(key)).toBeUndefined();
  first?.();
  const second = await lock.acquire(key);
  expect(second).toBeDefined();
  second?.();
});
test("release in finally on rejection and pre-acquire abort leave no lock", async () => {
  const { lock, fs, path } = rig();
  const release = await lock.acquire(key);
  await expect(
    (async () => {
      try {
        throw new Error("work failed");
      } finally {
        release?.();
      }
    })(),
  ).rejects.toThrow("work failed");
  expect(fs.exists(path)).toBe(false);
  const controller = new AbortController();
  controller.abort();
  await expect(lock.acquire(key, controller.signal)).rejects.toThrow();
  expect(fs.exists(path)).toBe(false);
});
