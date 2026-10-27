import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  FileNativeHelperRecordStore,
  type NativeHelperRecord,
} from "../../src/utils/nativeHelpers/NativeHelperRecordStore";
import { DefaultNativeHelperProcessControl } from "../../src/utils/nativeHelpers/NativeHelperProcessControl";
import { sweepNativeHelperOrphans } from "../../src/utils/nativeHelpers/sweepNativeHelperOrphans";
import { SystemTimer } from "../../src/utils/SystemTimer";
import { daemonProcessEnvironment } from "../../src/daemon/daemonOptionScopes";
import { FakeLogger } from "../fakes/FakeLogger";
import { useScratchRoot } from "../helpers/scratchRoot";

const control = new DefaultNativeHelperProcessControl();
const timer = new SystemTimer();
const scratch = useScratchRoot("native-helper-sweep-");
const started = new Map<number, string>();
const originalDataDir = process.env.AUTOMOBILE_DATA_DIR;
let dataDir: string;

beforeEach(() => {
  dataDir = scratch.next();
  process.env.AUTOMOBILE_DATA_DIR = dataDir;
});
afterEach(() => {
  if (originalDataDir === undefined) {
    delete process.env.AUTOMOBILE_DATA_DIR;
  } else {
    process.env.AUTOMOBILE_DATA_DIR = originalDataDir;
  }
});

afterAll(async () => {
  // Signal only processes started by this file, and only while their original identity matches.
  for (const [pid, identity] of started) {
    if (control.isRunning(pid) && control.readStartIdentity(pid) === identity) {
      control.signal(pid, "SIGKILL", { group: false });
    }
  }
  for (const [pid, identity] of started) {
    const deadline = timer.now() + 1_000;
    while (
      control.isRunning(pid) &&
      control.readStartIdentity(pid) === identity &&
      timer.now() < deadline
    ) {
      await timer.sleep(10);
    }
  }
});

async function start(command: string, args: string[]): Promise<ChildProcess> {
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });
  await once(child, "spawn");
  const identity = child.pid === undefined ? undefined : control.readStartIdentity(child.pid);
  if (identity === undefined) {
    // This newly-created child handle is still ours even on hosts without identity support.
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    throw new Error("Started child identity unavailable on a host with readable parent identity");
  }
  started.set(child.pid!, identity);
  return child;
}

function record(helper: ChildProcess, owner: ChildProcess): NativeHelperRecord {
  return {
    version: 1,
    kind: "adb",
    pid: helper.pid!,
    startIdentity: started.get(helper.pid!)!,
    processGroup: false,
    ownerPid: owner.pid!,
    ownerStartIdentity: started.get(owner.pid!)!,
    recordedAtMs: timer.now(),
  };
}

async function killOwner(owner: ChildProcess): Promise<void> {
  const exited = once(owner, "exit");
  control.signal(owner.pid!, "SIGKILL", { group: false });
  await exited;
}

function sweep(store: FileNativeHelperRecordStore) {
  return sweepNativeHelperOrphans({
    store,
    control,
    timer,
    graceMs: 100,
    deadlineMs: 2_000,
    logger: new FakeLogger(),
  });
}

const unsupported =
  process.platform === "win32" || control.readStartIdentity(process.pid) === undefined;
describe.skipIf(unsupported)("real native helper orphan sweep", () => {
  test("reaps a helper after its owner is SIGKILLed and persists private atomic JSON", async () => {
    const owner = await start("sleep", ["60"]);
    const helper = await start("sleep", ["60"]);
    const store = new FileNativeHelperRecordStore(new FakeLogger());
    const entry = record(helper, owner);
    store.write(entry);
    const path = join(dataDir, "native-helpers", `${helper.pid}.json`);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(entry);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    await killOwner(owner);
    expect((await sweep(store)).reaped).toBe(1);
    expect(control.isRunning(helper.pid!)).toBe(false);
    expect(store.list()).toEqual([]);
  }, 5_000);
  test("leaves a live owner's helper untouched", async () => {
    const owner = await start("sleep", ["60"]);
    const helper = await start("sleep", ["60"]);
    const store = new FileNativeHelperRecordStore(new FakeLogger());
    store.write(record(helper, owner));
    expect((await sweep(store)).skippedLiveOwner).toBe(1);
    expect(control.isRunning(helper.pid!)).toBe(true);
    expect(store.list()).toHaveLength(1);
  });
  test("discards a wrong helper identity without killing that live process", async () => {
    const owner = await start("sleep", ["60"]);
    const helper = await start("sleep", ["60"]);
    const store = new FileNativeHelperRecordStore(new FakeLogger());
    // A comparable (same scheme) but different generation is proof the pid was recycled; an
    // incomparable token is retained as unverifiable (#12347).
    const realIdentity = started.get(helper.pid!)!;
    const wrongIdentity = `${realIdentity.slice(0, realIdentity.indexOf(":"))}:deliberately-wrong`;
    store.write({ ...record(helper, owner), startIdentity: wrongIdentity });
    await killOwner(owner);
    expect((await sweep(store)).staleRecordsRemoved).toBe(1);
    expect(control.isRunning(helper.pid!)).toBe(true);
    expect(store.list()).toEqual([]);
  });
  test("leaves corrupt files untouched and warns", () => {
    const log = new FakeLogger();
    const store = new FileNativeHelperRecordStore(log);
    store.list();
    const file = join(dataDir, "native-helpers", "123.json");
    writeFileSync(file, "{broken", { mode: 0o600 });
    expect(store.list()).toEqual([]);
    expect(log.at("warn")).toHaveLength(1);
    expect(store.corruptRecordsSkipped).toBe(1);
    // Corrupt records are quarantined, never deleted, so the bytes stay inspectable.
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(`${file}.corrupt`, "utf8")).toBe("{broken");
  });
  test("reaps a registry-tracked helper after the real bun owner is SIGKILLed", async () => {
    const registryModule = resolve(
      import.meta.dir,
      "../../src/utils/nativeHelpers/NativeHelperRegistry.ts",
    );
    const script = `
      import {spawn} from "node:child_process";
      import {getNativeHelperRegistry} from ${JSON.stringify(registryModule)};
      const child = spawn("sleep", ["60"], {stdio: "ignore"});
      child.once("spawn", () => {
        getNativeHelperRegistry().track(child, {kind: "adb", processGroup: false});
        console.log(JSON.stringify({pid: child.pid}));
      });
      setInterval(() => {}, 1000);
    `;
    // Subscribe before spawn completes so a fast child cannot lose its readiness line. The owner
    // gets the real daemon's env: under Bun 1.4 an inherited no-orphans flag (from
    // `bun test --no-orphans`) would SIGKILL its helper with it on Linux, leaving nothing to reap.
    const owner = spawn(process.execPath, ["-e", script], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...daemonProcessEnvironment(process.env), AUTOMOBILE_DATA_DIR: dataDir },
    });
    const ready = new Promise<number>((resolvePid, reject) => {
      let output = "";
      owner.stdout!.on("data", (chunk) => {
        output += chunk.toString();
        const newline = output.indexOf("\n");
        if (newline < 0) {
          return;
        }
        try {
          const parsed: unknown = JSON.parse(output.slice(0, newline));
          if (
            parsed !== null &&
            typeof parsed === "object" &&
            "pid" in parsed &&
            typeof parsed.pid === "number"
          ) {
            resolvePid(parsed.pid);
          } else {
            reject(new Error("Invalid registry child readiness"));
          }
        } catch (error) {
          reject(error);
        }
      });
      owner.once("error", reject);
      owner.once("exit", () => reject(new Error("Registry owner exited before readiness")));
    });
    await once(owner, "spawn");
    const ownerIdentity = control.readStartIdentity(owner.pid!);
    expect(ownerIdentity).toBeDefined();
    started.set(owner.pid!, ownerIdentity!);
    const helperPid = await ready;
    const helperIdentity = control.readStartIdentity(helperPid);
    expect(helperIdentity).toBeDefined();
    started.set(helperPid, helperIdentity!);
    const store = new FileNativeHelperRecordStore(new FakeLogger());
    expect(store.list()).toEqual([
      expect.objectContaining({
        pid: helperPid,
        ownerPid: owner.pid,
        startIdentity: helperIdentity,
        ownerStartIdentity: ownerIdentity,
      }),
    ]);
    await killOwner(owner);
    expect((await sweep(store)).reaped).toBe(1);
    expect(control.isRunning(helperPid)).toBe(false);
    expect(store.list()).toEqual([]);
  }, 5_000);
});
