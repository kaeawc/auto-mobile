import { expect, spyOn, test } from "bun:test";
import { logger } from "../../../src/utils/logger";
import {
  DeviceConditionRegistry,
  createDefaultInjectorResolver,
} from "../../../src/features/deviceCondition/DeviceConditionRegistry";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BootedDevice, ExecResult } from "../../../src/models";
import type { AdbExecuteOptions } from "../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  createMemoryPressureInjector,
  resolveMemoryPressureInjector,
  parseMemAvailableKb,
  memoryPressureSizeMiB,
  countLmkdKills,
  MEMORY_PRESSURE_BINARY as BIN,
  MEMORY_PRESSURE_PID as PID,
  MEMORY_PRESSURE_OUTPUT as OUT,
} from "../../../src/features/deviceCondition/memoryPressureInjector";
import { DeviceConditionController } from "../../../src/features/deviceCondition/DeviceConditionController";
import { OwedResetError } from "../../../src/features/deviceCondition/OwedResetError";
import {
  deviceConditionChanges,
  deviceConditionInputIsMeaningful,
  deviceConditionInputSchema,
} from "../../../src/features/deviceCondition/DeviceConditionTypes";
import { resolveIosRefusalInjector } from "../../../src/features/deviceCondition/iosRefusalInjector";

test("default resolver wires faults.memoryPressure", () => {
  const resolve = createDefaultInjectorResolver({
    adbFactory: { create: () => new FakeAdbExecutor() },
  });
  expect(
    resolve(
      {
        deviceId: "memory-test",
        device: { deviceId: "memory-test", name: "fake", platform: "android" },
      },
      "faults.memoryPressure",
    ),
  ).toBeDefined();
});

const meminfo = readFileSync(
  new URL("../../fixtures/android-lmk/meminfo.txt", import.meta.url),
  "utf8",
);
const killLines = readFileSync(
  new URL("../../fixtures/android-lmk/lmkd-kill-lines.txt", import.meta.url),
  "utf8",
);
const android: BootedDevice = { deviceId: "pressure-fake", name: "fake", platform: "android" };
const ios: BootedDevice = { ...android, platform: "ios" };

function result(stdout = ""): ExecResult {
  return {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (text) => stdout.includes(text),
  };
}

/** Stateful shell fake: no host commands or devices; every accepted command is accounted for. */
class PressureDevice extends FakeAdbExecutor {
  readonly commands: string[] = [];
  readonly argv: string[][] = [];
  readonly files = new Set<string>();
  readonly processes = new Map<string, string>();
  /** The UID that started each process: a non-root shell gets EPERM killing a root one. */
  readonly owners = new Map<string, string>();
  /** adbd's UID: "0" after `adb root`, "2000" (shell) otherwise. */
  uid = "2000";
  /** The payload binary drops to the shell user when started as root (#16407); old builds did not. */
  dropsRoot = true;
  abi = "x86_64";
  mem = meminfo;
  logs = killLines;
  pidContents = "4321";
  ready = true;
  readyMisses = 0;
  logMisses = 0;
  ignoreRm = false;
  ignoreKill = false;
  reuseBeforeKill = false;
  exitAfterReady = false;
  beforeExecute?: (command: string) => Promise<void>;
  failOn?: string;

  override async execute(args: string[], options: AdbExecuteOptions = {}): Promise<ExecResult> {
    options.signal?.throwIfAborted();
    const command = args.join(" ");
    this.commands.push(command);
    this.argv.push(args);
    await this.beforeExecute?.(command);
    if (this.failOn && command.includes(this.failOn)) {
      throw new Error("fake transport failed");
    }
    if (args[0] === "push") {
      this.files.add(BIN);
      return result();
    }
    if (command.startsWith("shell for p in /proc/")) {
      return result(
        [...this.processes]
          .filter(([, name]) => name === BIN)
          .map(([pid]) => pid)
          .join("\n"),
      );
    }
    if (command.startsWith("shell if [")) {
      return this.kill(command);
    }
    return this.fileOrProbe(command);
  }

  private kill(command: string): ExecResult {
    const pid = /kill -TERM (\d+)/.exec(command)?.[1] ?? "";
    if (this.reuseBeforeKill) {
      this.processes.set(pid, "/system/bin/unrelated");
    }
    const permitted = this.uid === "0" || this.owners.get(pid) !== "0";
    if (!this.ignoreKill && permitted && this.processes.get(pid) === BIN) {
      this.processes.delete(pid);
    }
    return result();
  }

  private fileOrProbe(command: string): ExecResult {
    if (command === `shell cat ${PID} 2>/dev/null; true`) {
      return result(this.files.has(PID) ? this.pidContents : "");
    }
    if (command.startsWith("shell ls ")) {
      return result([...this.files].join("\n"));
    }
    if (command.startsWith("shell rm -f ")) {
      if (!this.ignoreRm) {
        this.files.clear();
      }
      return result();
    }
    if (command === "shell getprop ro.product.cpu.abi") {
      return result(this.abi);
    }
    if (command === "shell cat /proc/meminfo") {
      return result(this.mem);
    }
    if (command === "shell date +'%m-%d %H:%M:%S.000'") {
      return result("11-02 10:15:50.000");
    }
    if (command === `shell chmod 755 ${BIN}`) {
      return result();
    }
    if (command === `shell cat ${PID}`) {
      return result(this.files.has(PID) ? this.pidContents : "");
    }
    if (command === "shell grep ^Uid: /proc/4321/status") {
      const owner = this.owners.get("4321");
      return result(
        this.processes.has("4321") && owner ? `Uid:\t${owner}\t${owner}\t${owner}\t${owner}` : "",
      );
    }
    return this.payload(command);
  }

  private launch(owner: string): ExecResult {
    this.files.add(PID);
    this.files.add(OUT);
    this.processes.set("4321", BIN);
    this.owners.set("4321", owner);
    return result();
  }

  private payload(command: string): ExecResult {
    if (command.startsWith(`shell nohup ${BIN} `)) {
      return this.launch(this.uid === "0" && !this.dropsRoot ? "0" : "2000");
    }
    if (command === `shell cat ${OUT} 2>/dev/null; true`) {
      if (this.exitAfterReady) {
        this.processes.delete("4321");
      }
      return result(this.ready && this.readyMisses-- <= 0 ? "READY 1484\n" : "");
    }
    if (command === "shell logcat -d -b all -t '11-02 10:15:50.000'") {
      return result(this.logMisses-- > 0 ? "" : this.logs);
    }
    throw new Error(`Unexpected fake command: ${command}`);
  }
}

function harness(device = new PressureDevice()) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const options = {
    timer,
    // Isolated from the developer's own AUTOMOBILE_LMK_PRESSURE_DIR.
    env: {},
    resolveBinaryPath: (abi: string) => `/fake/${abi}/lmk_pressure`,
    binaryExists: () => true,
  };
  return { device, timer, options, injector: createMemoryPressureInjector(device, options) };
}

function expectClean(device: PressureDevice) {
  expect([...device.files]).toEqual([]);
  expect([...device.processes.values()].filter((name) => name === BIN)).toEqual([]);
}

test("captured MemAvailable sizes the payload with overshoot, payload minimum, floor and cap", () => {
  expect(parseMemAvailableKb(meminfo)).toBe(1389112);
  expect(memoryPressureSizeMiB(parseMemAvailableKb(meminfo))).toBe(1484);
  expect(memoryPressureSizeMiB(1189708)).toBe(1289);
  expect(memoryPressureSizeMiB(1532 * 1024)).toBe(1660);
  expect(memoryPressureSizeMiB(1583 * 1024)).toBe(1711);
  expect(memoryPressureSizeMiB(128 * 1024)).toBe(256);
  expect(memoryPressureSizeMiB(129 * 1024 - 1)).toBe(256);
  expect(memoryPressureSizeMiB((16384 - 128) * 1024 - 1)).toBe(16383);
  expect(memoryPressureSizeMiB((16384 - 128) * 1024)).toBe(16384);
  expect(memoryPressureSizeMiB((16384 - 128 + 1) * 1024)).toBe(16384);
  expect(memoryPressureSizeMiB(99_000_000)).toBe(16384);
  for (const kb of [0, 128 * 1024 - 1]) {
    expect(() => memoryPressureSizeMiB(kb)).toThrow("not enough available memory");
  }
  for (const kb of [-1, NaN, Infinity, 1.5]) {
    expect(() => memoryPressureSizeMiB(kb)).toThrow("invalid MemAvailable");
  }
  expect(() => parseMemAvailableKb("")).toThrow("could not read MemAvailable");
});

test("counts exactly the four captured lmkd kills and no unrelated logcat", () => {
  expect(countLmkdKills(killLines)).toBe(4);
  expect(
    countLmkdKills(
      "ActivityManager: Killing 123:app\nlowmemorykiller: other\nlowmemorykiller: Kill incomplete\notherlowmemorykiller: Kill 'pkg' (123)\nlowmemorykiller: Kill 'pkg' (abc)",
    ),
  ).toBe(0);
  expect(countLmkdKills("")).toBe(0);
});

test("public contract accepts on/unset, rejects other values, and extracts meaningful changes", () => {
  for (const value of ["on", "unset"]) {
    expect(
      deviceConditionInputSchema.safeParse({ faults: { memoryPressure: value } }).success,
    ).toBe(true);
  }
  for (const value of ["off", true, 1, {}]) {
    expect(
      deviceConditionInputSchema.safeParse({ faults: { memoryPressure: value } }).success,
    ).toBe(false);
  }
  const request = { faults: { memoryPressure: "on" as const } };
  expect(deviceConditionChanges(request)).toEqual([{ key: "faults.memoryPressure", value: "on" }]);
  expect(deviceConditionInputIsMeaningful(request)).toBe(true);
});

test("happy apply has exact ordered shell/push sequence, waits using FakeTimer and resets idempotently", async () => {
  const h = harness();
  h.device.readyMisses = 1;
  h.device.logMisses = 1;
  const applied = await h.injector.apply("on");
  expect(applied.status).toBe("applied");
  expect(applied.detail).toBe("4 lmkd kills with 1484 MiB memory pressure payload");
  expect(applied.reset).toBeDefined();
  const scan = `shell for p in /proc/[0-9]*; do if [ "$(tr '\\000' '\\n' < /proc/\u0024{p##*/}/cmdline 2>/dev/null | head -n 1)" = '${BIN}' ]; then echo "\u0024{p##*/}"; fi; done`;
  expect(h.device.commands).toEqual([
    `shell cat ${PID} 2>/dev/null; true`,
    scan,
    scan,
    `shell rm -f ${PID} ${OUT} ${BIN}`,
    `shell ls ${PID} ${OUT} ${BIN} 2>/dev/null; true`,
    scan,
    "shell getprop ro.product.cpu.abi",
    "shell cat /proc/meminfo",
    "shell date +'%m-%d %H:%M:%S.000'",
    `push /fake/x86_64/lmk_pressure ${BIN}`,
    `shell chmod 755 ${BIN}`,
    `shell nohup ${BIN} 1484 1800 >${OUT} 2>&1 </dev/null & echo $! > ${PID}`,
    `shell cat ${OUT} 2>/dev/null; true`,
    `shell cat ${OUT} 2>/dev/null; true`,
    `shell cat ${PID}`,
    "shell grep ^Uid: /proc/4321/status",
    "shell logcat -d -b all -t '11-02 10:15:50.000'",
    "shell logcat -d -b all -t '11-02 10:15:50.000'",
    scan,
  ]);
  expect(h.device.argv.find((args) => args[0] === "push")).toEqual([
    "push",
    "/fake/x86_64/lmk_pressure",
    BIN,
  ]);
  expect(h.timer.getSleepHistory()).toEqual([250, 250]);
  expect(await h.injector.isClean()).toBe(false);
  await applied.reset?.();
  expect(h.device.commands).toContain(
    `shell if [ "$(tr '\\000' '\\n' < /proc/4321/cmdline 2>/dev/null | head -n 1)" = '${BIN}' ]; then kill -TERM 4321; fi`,
  );
  expectClean(h.device);
  expect(await h.injector.isClean()).toBe(true);
  const before = h.device.commands.length;
  await applied.reset?.();
  expect(h.device.commands.length).toBe(before);
});

test("unknown ABI, missing binary and too-small memory are unsupported before push", async () => {
  const unknown = harness();
  unknown.device.abi = "armeabi-v7a";
  await expect(unknown.injector.apply("on")).rejects.toThrow("does not support ABI");
  const missing = harness();
  await expect(
    createMemoryPressureInjector(missing.device, {
      ...missing.options,
      binaryExists: () => false,
      releaseBinary: async () => null,
    }).apply("on"),
  ).rejects.toThrow(
    "bash scripts/android/build-lmk-pressure.sh or set AUTOMOBILE_LMK_PRESSURE_DIR",
  );
  const small = harness();
  small.device.mem = meminfo.replace("1389112", "1024");
  await expect(small.injector.apply("on")).rejects.toThrow("not enough available memory");
  for (const h of [unknown, missing, small]) {
    expectClean(h.device);
    expect(h.device.argv.some((args) => args[0] === "push")).toBe(false);
  }
});

test("arm64 selects its own binary without shell-quoting the host push argv", async () => {
  const h = harness();
  h.device.abi = "arm64-v8a";
  const injector = createMemoryPressureInjector(h.device, {
    ...h.options,
    resolveBinaryPath: (abi) => `/path with spaces/${abi}/lmk_pressure`,
  });
  const outcome = await injector.apply("on");
  expect(h.device.argv.find((args) => args[0] === "push")).toEqual([
    "push",
    "/path with spaces/arm64-v8a/lmk_pressure",
    BIN,
  ]);
  await outcome.reset?.();
});

test("no lmkd kill within 15 seconds rolls back every artifact and names the payload and MemAvailable", async () => {
  const h = harness();
  h.device.logs = "unrelated logcat";
  await expect(h.injector.apply("on")).rejects.toThrow(
    "1484 MiB (sized from MemAvailable 1389112 kB): no lmkd kill followed within 15 seconds",
  );
  expectClean(h.device);
  expect(h.timer.now()).toBe(15000);
  expect(h.timer.getSleepCallCount()).toBe(60);
});

test("READY timeout is bounded to 60 fake seconds and rolls back", async () => {
  const h = harness();
  h.device.ready = false;
  await expect(h.injector.apply("on")).rejects.toThrow("1484 MiB did not become READY");
  expectClean(h.device);
  expect(h.timer.now()).toBe(60000);
  expect(h.timer.getSleepCallCount()).toBe(240);
});

test("an exited payload cannot be reported as applied even when kills were logged", async () => {
  const h = harness();
  h.device.exitAfterReady = true;
  await expect(h.injector.apply("on")).rejects.toThrow("exited after 4 lmkd kills");
  expectClean(h.device);
});

test("reset fails loudly on retained files and retries successfully", async () => {
  const h = harness();
  const applied = await h.injector.apply("on");
  h.device.ignoreRm = true;
  await expect(applied.reset?.()).rejects.toThrow("artifacts are still present");
  expect(await h.injector.isClean()).toBe(false);
  h.device.ignoreRm = false;
  await applied.reset?.();
  expectClean(h.device);
});

test("reset fails loudly on a surviving process, retains ownership and retries", async () => {
  const h = harness();
  const applied = await h.injector.apply("on");
  h.device.ignoreKill = true;
  await expect(applied.reset?.()).rejects.toThrow("process is still alive");
  expect(h.timer.now()).toBe(5000);
  h.device.ignoreKill = false;
  await applied.reset?.();
  expectClean(h.device);
});

test("PID reuse, including reuse between probe and kill, never kills an unrelated process", async () => {
  for (const reuseDuringKill of [false, true]) {
    const h = harness();
    const applied = await h.injector.apply("on");
    if (reuseDuringKill) {
      h.device.reuseBeforeKill = true;
    } else {
      h.device.processes.set("4321", "/system/bin/unrelated");
    }
    await applied.reset?.();
    expect(h.device.processes.get("4321")).toBe("/system/bin/unrelated");
    expectClean(h.device);
  }
});

test("failed rollback retains an OwedResetError whose reset cleans up later", async () => {
  const h = harness();
  h.device.logs = "";
  h.device.beforeExecute = async (command) => {
    if (command.startsWith("shell logcat")) {
      h.device.ignoreRm = true;
    }
  };
  let caught: unknown;
  try {
    await h.injector.apply("on");
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(OwedResetError);
  if (!(caught instanceof OwedResetError)) {
    throw new Error("expected owed reset");
  }
  h.device.ignoreRm = false;
  await caught.owedReset();
  expectClean(h.device);
});

test("transport failure after push rolls back, and request cancellation does not cancel cleanup", async () => {
  const h = harness();
  h.device.failOn = "chmod 755";
  await expect(h.injector.apply("on")).rejects.toThrow("fake transport failed");
  expectClean(h.device);
  h.device.failOn = undefined;
  const abort = new AbortController();
  h.device.beforeExecute = async (command) => {
    if (command.startsWith("shell nohup")) {
      abort.abort();
    }
  };
  await expect(h.injector.apply("on", abort.signal)).rejects.toThrow();
  expectClean(h.device);
});

test("recovery after a daemon restart cleans live processes and leftovers, including missing PID files", async () => {
  const h = harness();
  await h.injector.apply("on");
  expect(await h.injector.recover?.()).toBeNull();
  for (const leftovers of [[PID, BIN, OUT], [PID], [BIN], [OUT], []]) {
    h.device.files.clear();
    for (const file of leftovers) {
      h.device.files.add(file);
    }
    h.device.processes.set("4321", BIN);
    const fresh = createMemoryPressureInjector(h.device, h.options);
    const recovered = await fresh.recover?.();
    expect(recovered).toBeDefined();
    expect(recovered).not.toBeNull();
    await recovered?.();
    expectClean(h.device);
    expect(await fresh.recover?.()).toBeNull();
  }
});

test("failed restart discovery retains the registry slot for session cleanup and a later reset", async () => {
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    const h = harness();
    await h.injector.apply("on");
    const registry = new DeviceConditionRegistry(
      createDefaultInjectorResolver({
        ...h.options,
        adbFactory: { create: () => h.device },
      }),
      h.timer,
    );
    const owner = { sessionUuid: "pressure-session", deviceId: android.deviceId, device: android };
    h.device.failOn = `shell ls ${PID}`;
    const failed = await registry.apply(owner, { reset: true });
    expect(failed.success).toBe(false);
    expect(failed.restore?.verifiedClean).toBe(false);
    expect(failed.restore?.failures).toContainEqual({
      key: "faults.memoryPressure",
      error:
        "Could not check the device for an abandoned faults.memoryPressure fixture (fake transport failed). Reconnect the device and run reset again, or release the session to retry.",
    });
    expect(registry.hasActiveConditions(owner)).toBe(true);
    await expect(registry.restoreSession(owner.sessionUuid)).resolves.toEqual([false]);
    expect(registry.hasActiveConditions(owner)).toBe(true);
    expect(h.device.processes.get("4321")).toBe(BIN);
    h.device.failOn = undefined;
    const retried = await registry.apply(owner, { reset: true });
    expect(retried.success).toBe(true);
    expect(retried.restore?.verifiedClean).toBe(true);
    expectClean(h.device);
    expect(registry.hasActiveConditions(owner)).toBe(false);
  } finally {
    warn.mockRestore();
  }
});

test("fresh default resolver and controller recover through unset and reset", async () => {
  for (const request of [
    { faults: { memoryPressure: "unset" as const } },
    { reset: true as const },
  ]) {
    const h = harness();
    await h.injector.apply("on");
    const resolve = createDefaultInjectorResolver({
      ...h.options,
      adbFactory: { create: () => h.device },
    });
    const controller = new DeviceConditionController((key) =>
      resolve({ deviceId: android.deviceId, device: android }, key),
    );
    const response = await controller.apply(request);
    expect(response.success).toBe(true);
    expectClean(h.device);
    expect(controller.activeKeys()).toEqual([]);
  }
});

test("repeat apply is unchanged while alive; after exit a fresh payload owns a reset", async () => {
  const h = harness();
  await h.injector.apply("on");
  expect((await h.injector.apply("on")).status).toBe("unchanged");
  expect(h.device.argv.filter((args) => args[0] === "push")).toHaveLength(1);
  h.device.processes.clear();
  const renewed = await h.injector.apply("on");
  expect(renewed.status).toBe("applied");
  await renewed.reset?.();
  expectClean(h.device);
});

test("apply queues behind an in-flight reset and cannot lose ownership", async () => {
  const h = harness();
  const first = await h.injector.apply("on");
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let blocked = false;
  h.device.beforeExecute = async (command) => {
    if (command.startsWith("shell rm") && !blocked) {
      blocked = true;
      await gate;
    }
  };
  const resetting = first.reset?.();
  const applying = h.injector.apply("on");
  for (let n = 0; n < 30; n++) {
    await Promise.resolve();
  }
  expect(blocked).toBe(true);
  expect(h.device.argv.filter((args) => args[0] === "push")).toHaveLength(1);
  release();
  await resetting;
  const second = await applying;
  expect(second.status).toBe("applied");
  await second.reset?.();
  expectClean(h.device);
});

test("resolver caches per device and refuses other platforms/keys; iOS gives the Android-only refusal", async () => {
  const h = harness();
  const deps = { ...h.options, adbFactory: { create: () => h.device }, cache: new Map() };
  const one = resolveMemoryPressureInjector(android, "faults.memoryPressure", deps);
  expect(resolveMemoryPressureInjector(android, "faults.memoryPressure", deps)).toBe(one);
  expect(
    resolveMemoryPressureInjector({ ...android, deviceId: "other" }, "faults.memoryPressure", deps),
  ).not.toBe(one);
  expect(resolveMemoryPressureInjector(ios, "faults.memoryPressure", deps)).toBeUndefined();
  expect(resolveMemoryPressureInjector(android, "faults.storage", deps)).toBeUndefined();
  await expect(
    resolveIosRefusalInjector(ios, "faults.memoryPressure")?.apply("on"),
  ).rejects.toThrow("Android system service");
  await expect(h.injector.apply("off")).rejects.toThrow("Invalid faults.memoryPressure");
  expect(h.device.commands).toEqual([]);
});

test("default binary directory follows the package root and the injected environment overrides it", async () => {
  for (const directory of [undefined, "/custom pressure"]) {
    const h = harness();
    const paths: string[] = [];
    const injector = createMemoryPressureInjector(h.device, {
      timer: h.timer,
      env: directory ? { AUTOMOBILE_LMK_PRESSURE_DIR: directory } : {},
      binaryExists: (path) => {
        paths.push(path);
        return true;
      },
    });
    const applied = await injector.apply("on");
    expect(paths).toEqual([
      directory
        ? join(directory, "x86_64", "lmk_pressure")
        : resolve(
            dirname(fileURLToPath(import.meta.url)),
            "../../../build/lmk-pressure",
            "x86_64",
            "lmk_pressure",
          ),
    ]);
    await applied.reset?.();
  }
});

test("a relative binary directory override resolves against the daemon launch directory, not the process cwd", async () => {
  const h = harness();
  const paths: string[] = [];
  const injector = createMemoryPressureInjector(h.device, {
    timer: h.timer,
    env: {
      AUTOMOBILE_LMK_PRESSURE_DIR: "build/lmk-pressure",
      AUTOMOBILE_DAEMON_LAUNCH_CWD: "/launch dir",
    },
    binaryExists: (path) => {
      paths.push(path);
      return true;
    },
  });
  const applied = await injector.apply("on");
  expect(paths).toEqual([resolve("/launch dir", "build/lmk-pressure", "x86_64", "lmk_pressure")]);
  await applied.reset?.();
});

test("recovery removes file-only leftovers without touching an unrelated reused PID", async () => {
  for (const leftovers of [[PID], [BIN], [PID, BIN, OUT]]) {
    const h = harness();
    for (const path of leftovers) {
      h.device.files.add(path);
    }
    h.device.processes.set("4321", "/system/bin/unrelated");
    const reset = await h.injector.recover?.();
    expect(reset).not.toBeNull();
    await reset?.();
    expectClean(h.device);
    expect(h.device.processes.get("4321")).toBe("/system/bin/unrelated");
  }
});

test("apply replaces a stale payload before measuring and serializes simultaneous applies", async () => {
  const h = harness();
  h.device.processes.set("4321", BIN);
  h.device.files.add(BIN);
  h.device.files.add(PID);
  h.device.files.add(OUT);
  const [first, second] = await Promise.all([h.injector.apply("on"), h.injector.apply("on")]);
  expect(first.status).toBe("applied");
  expect(second.status).toBe("unchanged");
  expect(h.device.commands.findIndex((command) => command.includes("then kill"))).toBeLessThan(
    h.device.commands.indexOf("shell cat /proc/meminfo"),
  );
  expect(h.device.argv.filter((args) => args[0] === "push")).toHaveLength(1);
  await first.reset?.();
  expectClean(h.device);
});

test("untrusted PID-file contents cannot become shell syntax or a process-group signal", async () => {
  for (const pid of ["0", "-1", "4321; unrelated", "not-a-pid"]) {
    const h = harness();
    h.device.files.add(PID);
    h.device.pidContents = pid;
    const reset = await h.injector.recover?.();
    await reset?.();
    expectClean(h.device);
    expect(h.device.commands.some((command) => command.includes("then kill"))).toBe(false);
  }
});

test("without a local build the released binary for the device ABI is pushed (#16402)", async () => {
  const h = harness();
  const requested: string[] = [];
  const injector = createMemoryPressureInjector(h.device, {
    ...h.options,
    binaryExists: () => false,
    releaseBinary: async (abi) => {
      requested.push(abi);
      return `/cache/lmk-pressure/${abi}/lmk_pressure`;
    },
  });
  const applied = await injector.apply("on");
  expect(requested).toEqual(["x86_64"]);
  expect(h.device.argv.find((args) => args[0] === "push")).toEqual([
    "push",
    "/cache/lmk-pressure/x86_64/lmk_pressure",
    BIN,
  ]);
  await applied.reset?.();
});

test("a local build wins over the release download (#16402)", async () => {
  const h = harness();
  let downloaded = false;
  const injector = createMemoryPressureInjector(h.device, {
    ...h.options,
    releaseBinary: async () => {
      downloaded = true;
      return "/cache/never";
    },
  });
  const applied = await injector.apply("on");
  expect(downloaded).toBe(false);
  expect(h.device.argv.find((args) => args[0] === "push")?.[1]).toBe("/fake/x86_64/lmk_pressure");
  await applied.reset?.();
});

test("an explicit directory without the binary is unsupported and never downloads (#16402)", async () => {
  const h = harness();
  let downloaded = false;
  const injector = createMemoryPressureInjector(h.device, {
    timer: h.timer,
    env: { AUTOMOBILE_LMK_PRESSURE_DIR: "/custom pressure" },
    binaryExists: () => false,
    releaseBinary: async () => {
      downloaded = true;
      return "/cache/never";
    },
  });
  await expect(injector.apply("on")).rejects.toThrow(
    `missing pressure binary ${join("/custom pressure", "x86_64", "lmk_pressure")}`,
  );
  expect(downloaded).toBe(false);
  expect(h.device.argv.some((args) => args[0] === "push")).toBe(false);
});

test("a failed release verification surfaces as an error, not a silent skip (#16402)", async () => {
  const h = harness();
  const injector = createMemoryPressureInjector(h.device, {
    ...h.options,
    binaryExists: () => false,
    releaseBinary: async () => {
      throw new Error("x86_64 memory-pressure binary checksum verification failed");
    },
  });
  await expect(injector.apply("on")).rejects.toThrow("checksum verification failed");
  expect(h.device.argv.some((args) => args[0] === "push")).toBe(false);
});

test("a payload started under a rooted adbd can still be stopped after unroot (#16407)", async () => {
  const h = harness();
  h.device.uid = "0";
  const applied = await h.injector.apply("on");
  expect(applied.status).toBe("applied");
  // No su: rootState may plant inert su stubs, so the payload drops to the shell user itself.
  expect(h.device.commands.some((command) => command.includes(" su "))).toBe(false);
  expect(h.device.owners.get("4321")).toBe("2000");

  // Clearing rootState runs `adb unroot`; the reset then runs as the shell user.
  h.device.uid = "2000";
  await applied.reset!();

  expectClean(h.device);
});

test("a root-owned payload from an older build is refused while adbd can still stop it", async () => {
  const h = harness();
  h.device.uid = "0";
  h.device.dropsRoot = false;

  await expect(h.injector.apply("on")).rejects.toThrow(
    "memory pressure payload runs as uid 0, not the shell user; rebuild it",
  );

  expectClean(h.device);
});
