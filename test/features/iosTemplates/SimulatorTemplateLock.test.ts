import os from "node:os";
import * as tempDir from "../../../src/utils/tempDir";
import { FileSimulatorTemplateManifestStore } from "../../../src/features/iosTemplates/FileSimulatorTemplateManifestStore";
import { FakeTemplateManifestFiles } from "../../fakes/FakeTemplateManifestFiles";
import { SimulatorTemplatesHarness } from "../../helpers/SimulatorTemplatesHarness";
import { join } from "node:path";
import { expect, spyOn, test } from "bun:test";
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

test("different coordination roots share default manifest and lock directories without host IO", async () => {
  const previous = process.env.AUTOMOBILE_COORDINATION_DIR;
  const home = spyOn(os, "userInfo").mockReturnValue({
    uid: 501,
    gid: 20,
    username: "tester",
    homedir: "/host-home",
    shell: "/bin/zsh",
  });
  const secure = spyOn(tempDir, "ensureSecureDirectorySync").mockImplementation(
    (directory) => directory,
  );
  const timer = new FakeTimer();
  const fs = new FakeLockFileSystem(() => timer.now());
  const files = new FakeTemplateManifestFiles();
  const fake = new SimulatorTemplatesHarness();
  fake.ready();
  const createLock = () =>
    new FileSimulatorTemplateLock(timer, undefined, {
      fileSystem: fs,
      pid: 42,
      isProcessRunning: () => true,
      ownerGeneration: new FakeLockOwnerGenerationProbe(),
      idGenerator: new FakeIdGenerator(),
      now: () => timer.now(),
    });
  let release: (() => void) | undefined;
  try {
    process.env.AUTOMOBILE_COORDINATION_DIR = "/daemon-a";
    await new FileSimulatorTemplateManifestStore(files).write(fake.manifest!);
    release = await createLock().acquire(key);
    expect(release).toBeDefined();
    process.env.AUTOMOBILE_COORDINATION_DIR = "/daemon-b";
    expect(await new FileSimulatorTemplateManifestStore(files).read(key)).toEqual(fake.manifest);
    expect(await createLock().acquire(key)).toBeUndefined();
    const root = join("/host-home", ".auto-mobile", "ios-sim-templates");
    expect([...files.files.keys()]).toEqual([join(root, `${templateKeyHash(key)}.json`)]);
    expect(fs.exists(join(root, `${templateKeyHash(key)}.lock`))).toBe(true);
    expect(secure.mock.calls.every(([directory]) => directory === root)).toBe(true);
  } finally {
    release?.();
    secure.mockRestore();
    home.mockRestore();
    if (previous === undefined) {
      delete process.env.AUTOMOBILE_COORDINATION_DIR;
    } else {
      process.env.AUTOMOBILE_COORDINATION_DIR = previous;
    }
  }
});
