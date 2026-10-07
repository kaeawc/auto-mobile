import {
  AdbClient,
  AdbCommandTimeoutError,
} from "../../../src/utils/android-cmdline-tools/AdbClient";
import { DUMPSYS_MAX_BUFFER } from "../../../src/utils/android-cmdline-tools/dumpsysLimits";
import { createExecResult } from "../../../src/utils/execResult";
import { DefaultRetryExecutor } from "../../../src/utils/retry/RetryExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";
import { expect, test } from "bun:test";
import {
  AndroidImeCatalog,
  AUTO_MOBILE_IME_ID,
  imeCapabilities,
  createForegroundUserSource,
  pinnedUser,
  parseAdvertisedImeSubtypes,
  parsePackageVersionName,
  parseSelectedImeSubtype,
} from "../../../src/features/action/AndroidImeCatalog";
import {
  quarantineAndroidIme,
  withAndroidImeLock,
} from "../../../src/features/action/androidImeLock";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeMultiUserImeAdb } from "../../fakes/FakeMultiUserImeAdb";
import type { AdbExecuteOptions } from "../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";

const primaryIme = "com.example.primaryime/.PrimaryImeService";
const alternateIme = "com.example.alternateime/.AlternateImeService";

const ADVERTISED_SUBTYPE_UNIT_VECTOR = `mId=${primaryIme}\n  mSubtypeId=42 mSubtypeLocale=en_US\nmId=${alternateIme}\n  mSubtypeId=42 mSubtypeLocale=ko_KR`;

function fixture(deviceId = "test-device") {
  const adb = new FakeAdbExecutor();
  adb.setCommandResponse("shell ime list -a -s", {
    stdout: `${primaryIme}\n${alternateIme}\n`,
    stderr: "",
  });
  adb.setCommandResponse("shell ime list -s", { stdout: `${primaryIme}\n`, stderr: "" });
  adb.setCommandResponse("shell settings get secure default_input_method", {
    stdout: `${primaryIme}\n`,
    stderr: "",
  });
  return { adb, catalog: new AndroidImeCatalog(adb, deviceId, pinnedUser(0)) };
}

test("explicit selection recovers quarantine only after verified IME readback", async () => {
  const deviceId = "quarantined-select-success";
  const { adb, catalog } = fixture(deviceId);
  adb.setCommandResponse("shell ime list -s", {
    stdout: `${primaryIme}\n${alternateIme}\n`,
    stderr: "",
  });
  adb.setCommandResponseSequence("shell settings get secure default_input_method", [
    { stdout: primaryIme, stderr: "" },
    { stdout: alternateIme, stderr: "" },
  ]);
  quarantineAndroidIme(deviceId);

  expect((await catalog.select(alternateIme)).activeImeId).toBe(alternateIme);
  expect(adb.getExecutedArgv()).toContainEqual(["shell", "ime", "set", alternateIme]);
  expect(await withAndroidImeLock(deviceId, async () => "ordinary operation")).toBe(
    "ordinary operation",
  );
});

test("explicit selection of the already active IME recovers quarantine by readback", async () => {
  const deviceId = "quarantined-select-active";
  const { adb, catalog } = fixture(deviceId);
  quarantineAndroidIme(deviceId);

  expect((await catalog.select(primaryIme)).activeImeId).toBe(primaryIme);
  expect(adb.getExecutedCommands()).toContain("shell settings get secure default_input_method");
  expect(await withAndroidImeLock(deviceId, async () => true)).toBe(true);
});

test("mismatched selection readback leaves the device quarantined", async () => {
  const deviceId = "quarantined-select-mismatch";
  const { adb, catalog } = fixture(deviceId);
  adb.setCommandResponse("shell ime list -s", {
    stdout: `${primaryIme}\n${alternateIme}\n`,
    stderr: "",
  });
  quarantineAndroidIme(deviceId);

  await expect(catalog.select(alternateIme)).rejects.toThrow("did not take effect");
  expect(adb.getExecutedArgv()).toContainEqual(["shell", "ime", "set", alternateIme]);
  await expect(withAndroidImeLock(deviceId, async () => true)).rejects.toThrow(
    "IME state is unknown",
  );
});

test("failed ime set leaves the device quarantined and surfaces its error", async () => {
  const deviceId = "quarantined-select-failure";
  const { adb, catalog } = fixture(deviceId);
  adb.setCommandResponse("shell ime list -s", {
    stdout: `${primaryIme}\n${alternateIme}\n`,
    stderr: "",
  });
  adb.setCommandResponse(`shell ime set ${alternateIme}`, {
    stdout: "",
    stderr: "permission denied",
  });
  quarantineAndroidIme(deviceId);

  await expect(catalog.select(alternateIme)).rejects.toThrow(
    `Failed to select IME ${alternateIme}: permission denied`,
  );
  await expect(withAndroidImeLock(deviceId, async () => true)).rejects.toThrow(
    "IME state is unknown",
  );
});

test("failed selection readback leaves the device quarantined", async () => {
  const deviceId = "quarantined-select-readback-failure";
  const { adb, catalog } = fixture(deviceId);
  adb.setCommandResponse("shell ime list -s", {
    stdout: `${primaryIme}\n${alternateIme}\n`,
    stderr: "",
  });
  adb.setCommandResponseSequence("shell settings get secure default_input_method", [
    { stdout: primaryIme, stderr: "" },
    { stdout: "", stderr: "permission denied" },
  ]);
  quarantineAndroidIme(deviceId);

  await expect(catalog.select(alternateIme)).rejects.toThrow(
    "Failed to read active IME: permission denied",
  );
  await expect(withAndroidImeLock(deviceId, async () => true)).rejects.toThrow(
    "IME state is unknown",
  );
});

test("scoped selection does not clear quarantine", async () => {
  const deviceId = "quarantined-select-scoped";
  const { catalog } = fixture(deviceId);
  quarantineAndroidIme(deviceId);

  expect((await catalog.selectWithinLock(primaryIme)).activeImeId).toBe(primaryIme);
  await expect(withAndroidImeLock(deviceId, async () => true)).rejects.toThrow(
    "IME state is unknown",
  );
});

test("quarantined explicit selection holds the lock until readback before an ordinary operation", async () => {
  const deviceId = "quarantined-select-serialization";
  const { adb } = fixture(deviceId);
  adb.setCommandResponse("shell ime list -s", {
    stdout: `${primaryIme}\n${alternateIme}\n`,
    stderr: "",
  });
  adb.setCommandResponseSequence("shell settings get secure default_input_method", [
    { stdout: primaryIme, stderr: "" },
    { stdout: alternateIme, stderr: "" },
  ]);
  let enteredSet: () => void = () => {};
  const setStarted = new Promise<void>((resolve) => {
    enteredSet = resolve;
  });
  let releaseSet: () => void = () => {};
  const setHeld = new Promise<void>((resolve) => {
    releaseSet = resolve;
  });
  const catalog = new AndroidImeCatalog(
    {
      execute: async (args: string[], options?: AdbExecuteOptions) => {
        if (args.join(" ") === `shell ime set ${alternateIme}`) {
          enteredSet();
          await setHeld;
        }
        return adb.execute(args, options);
      },
    },
    deviceId,
    pinnedUser(0),
  );
  quarantineAndroidIme(deviceId);
  const selection = catalog.select(alternateIme);
  await Promise.race([setStarted, selection]);
  let ran = false;
  const ordinary = withAndroidImeLock(deviceId, async () => {
    ran = true;
  });
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
  }
  const ranBeforeReadback = ran;
  const readsBeforeRelease = adb
    .getExecutedCommands()
    .filter((command) => command === "shell settings get secure default_input_method").length;
  releaseSet();
  await Promise.all([selection, ordinary]);
  expect(ranBeforeReadback).toBe(false);
  expect(readsBeforeRelease).toBe(1);
  expect(ran).toBe(true);
  expect(
    adb
      .getExecutedCommands()
      .filter((command) => command === "shell settings get secure default_input_method").length,
  ).toBe(2);
});

test("lists actual installed IMEs separately from enabled and active state", async () => {
  const { catalog } = fixture();
  expect(await catalog.list()).toEqual({
    activeImeId: primaryIme,
    installed: [
      { id: primaryIme, enabled: true, active: true, capabilities: imeCapabilities(primaryIme) },
      {
        id: alternateIme,
        enabled: false,
        active: false,
        capabilities: imeCapabilities(alternateIme),
      },
    ],
  });
});

test("select rejects an unknown or disabled IME before running ime set", async () => {
  const { adb, catalog } = fixture();
  await expect(catalog.select("com.example/.Injected;echo bad")).rejects.toThrow("not installed");
  await expect(catalog.select(alternateIme)).rejects.toThrow("installed but disabled");
  expect(adb.getExecutedCommands().some((command) => command.startsWith("shell ime set"))).toBe(
    false,
  );
});

test("select uses component argv and verifies the resulting active IME", async () => {
  const { adb, catalog } = fixture();
  adb.setCommandResponse("shell ime list -s", {
    stdout: `${primaryIme}\n${alternateIme}\n`,
    stderr: "",
  });
  adb.setCommandResponseSequence("shell settings get secure default_input_method", [
    { stdout: primaryIme, stderr: "" },
    { stdout: alternateIme, stderr: "" },
  ]);
  expect((await catalog.select(alternateIme)).activeImeId).toBe(alternateIme);
  expect(adb.getExecutedArgv()).toContainEqual(["shell", "ime", "set", alternateIme]);
  expect(
    adb.getCommandCalls().find((call) => call.command === `shell ime set ${alternateIme}`)
      ?.waitForProcessSettlementAfterAbort,
  ).toBe(true);
  expect(
    adb.getCommandCalls().find((call) => call.command === `shell ime set ${alternateIme}`)
      ?.timeoutMs,
  ).toBe(5_000);
});

test("select reports a failed postcondition instead of claiming readiness", async () => {
  const { adb, catalog } = fixture();
  adb.setCommandResponse("shell ime list -s", {
    stdout: `${primaryIme}\n${alternateIme}\n`,
    stderr: "",
  });
  await expect(catalog.select(alternateIme)).rejects.toThrow("did not take effect");
});

test("rejects malformed list output before it can become a selectable component", async () => {
  const { adb, catalog } = fixture();
  adb.setCommandResponse("shell ime list -a -s", {
    stdout: "Error: service not ready",
    stderr: "",
  });
  await expect(catalog.list()).rejects.toThrow("invalid IME component list");
});

test("selection waits for another IME operation on the same device", async () => {
  const { adb, catalog } = fixture();
  let release: () => void = () => {};
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const inFlight = withAndroidImeLock("test-device", () => hold);
  const selection = catalog.select(primaryIme);
  await Promise.resolve();
  expect(adb.getExecutedArgv()).toEqual([]);
  release();
  await inFlight;
  expect((await selection).activeImeId).toBe(primaryIme);
});

test("reports the verified IME after cancellation following set dispatch", async () => {
  const { adb } = fixture();
  const controller = new AbortController();
  adb.setCommandResponse("shell ime list -s", {
    stdout: `${primaryIme}\n${alternateIme}\n`,
    stderr: "",
  });
  adb.setCommandResponseSequence("shell settings get secure default_input_method", [
    { stdout: primaryIme, stderr: "" },
    { stdout: alternateIme, stderr: "" },
  ]);
  const catalog = new AndroidImeCatalog(
    {
      execute: async (args: string[], options?: AdbExecuteOptions) => {
        if (args.join(" ") !== `shell ime set ${alternateIme}`) {
          return adb.execute(args, options);
        }
        await options?.beforeDispatch?.();
        controller.abort();
        options?.signal?.throwIfAborted();
        return adb.execute(args, { signal: options?.signal });
      },
    },
    "dispatch-cancel-device",
    pinnedUser(0),
  );

  expect((await catalog.selectWithinLock(alternateIme, controller.signal)).activeImeId).toBe(
    alternateIme,
  );
});

test("reports a genuine set failure after cancellation following dispatch", async () => {
  const { adb } = fixture();
  const controller = new AbortController();
  adb.setCommandResponse("shell ime list -s", {
    stdout: `${primaryIme}\n${alternateIme}\n`,
    stderr: "",
  });
  const catalog = new AndroidImeCatalog(
    {
      execute: async (args: string[], options?: AdbExecuteOptions) => {
        if (args.join(" ") !== `shell ime set ${alternateIme}`) {
          return adb.execute(args, options);
        }
        await options?.beforeDispatch?.();
        controller.abort();
        options?.signal?.throwIfAborted();
        return adb.execute(args, { signal: options?.signal });
      },
    },
    "dispatch-failure-device",
    pinnedUser(0),
  );
  adb.setCommandResponse(`shell ime set ${alternateIme}`, {
    stdout: "",
    stderr: "permission denied",
  });

  await expect(catalog.selectWithinLock(alternateIme, controller.signal)).rejects.toThrow(
    "Failed to select IME",
  );
});

test("cancels set before dispatch without changing the active IME", async () => {
  const { adb } = fixture();
  const controller = new AbortController();
  adb.setCommandResponse("shell ime list -s", {
    stdout: `${primaryIme}\n${alternateIme}\n`,
    stderr: "",
  });
  let dispatched = false;
  let enteredQueue: () => void = () => {};
  const queued = new Promise<void>((resolve) => {
    enteredQueue = resolve;
  });
  const catalog = new AndroidImeCatalog(
    {
      execute: async (args: string[], options?: AdbExecuteOptions) => {
        if (args.join(" ") !== `shell ime set ${alternateIme}`) {
          return adb.execute(args, options);
        }
        enteredQueue();
        await new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
            once: true,
          });
        });
        await options?.beforeDispatch?.();
        dispatched = true;
        return adb.execute(args, { signal: options?.signal });
      },
    },
    "queued-cancel-device",
    pinnedUser(0),
  );

  const selection = catalog.selectWithinLock(alternateIme, controller.signal);
  await queued;
  controller.abort();
  await expect(selection).rejects.toThrow();
  expect(dispatched).toBe(false);
  expect(adb.getExecutedArgv()).not.toContainEqual(["shell", "ime", "set", alternateIme]);
});

test("reports static capabilities for installed and AutoMobile IMEs", () => {
  expect(imeCapabilities(primaryIme)).toEqual({
    visibleKeyTap: true,
    gesture: false,
    suggestion: false,
    clipboard: false,
    semanticText: false,
  });
  expect(imeCapabilities(AUTO_MOBILE_IME_ID)).toEqual({
    visibleKeyTap: false,
    gesture: false,
    suggestion: false,
    clipboard: false,
    semanticText: true,
  });
});

test("parses selected subtype sentinels and rejects diagnostics", () => {
  expect(parseSelectedImeSubtype("null\n")).toBeNull();
  expect(parseSelectedImeSubtype("-1\n")).toBeNull();
  expect(parseSelectedImeSubtype("42\n")).toBe(42);
  expect(parseSelectedImeSubtype("-42\n")).toBe(-42);
  expect(() => parseSelectedImeSubtype("Permission denied")).toThrow(
    "Invalid selected IME subtype",
  );
  expect(() => parseSelectedImeSubtype("9007199254740993")).toThrow("Invalid selected IME subtype");
});

test("advertised subtype parsing requires an exact component and accepts signed IDs", () => {
  const dump = `mId=${primaryIme}Extra\n  mSubtypeId=42 mSubtypeLocale=wrong\nmId=${primaryIme}\n  mSubtypeId=-42 mSubtypeLocale=en_US`;
  expect(parseAdvertisedImeSubtypes(dump, primaryIme)?.get(-42)).toBe("en_US");
  expect(parseAdvertisedImeSubtypes(dump, primaryIme)?.has(42)).toBe(false);
});

test("finds only the target package version in realistic multi-package dumpsys output", () => {
  const dump = `Packages:
  Package [com.example.other] (8765):
    userId=10001
    pkg=Package{123 com.example.other}
    versionCode=11 minSdk=23 targetSdk=35
    versionName=9.9.9
  Package [com.example.primaryime] (4321):
    userId=10002
    pkg=Package{456 com.example.primaryime}
    versionCode=150000 minSdk=23 targetSdk=35
    versionName=15.2.08.677488654-release-arm64-v8a
    signatures=PackageSignatures{abc}
Shared users:
  SharedUser [android.uid.system] (123):
    versionName=unrelated
Dexopt state:
  [com.example.primaryime]
    versionName=also-unrelated`;
  expect(parsePackageVersionName(dump, "com.example.primaryime")).toBe(
    "15.2.08.677488654-release-arm64-v8a",
  );
  expect(parsePackageVersionName(dump, "com.example.missing")).toBeUndefined();
});

test("captures identity and subtype without inventing absent optional fields", async () => {
  const { adb, catalog } = fixture();
  adb.setCommandResponse("shell settings get secure selected_input_method_subtype", {
    stdout: "42\n",
    stderr: "",
  });
  adb.setCommandResponse("shell dumpsys input_method", {
    stdout: ADVERTISED_SUBTYPE_UNIT_VECTOR,
    stderr: "",
  });
  expect(parseAdvertisedImeSubtypes(ADVERTISED_SUBTYPE_UNIT_VECTOR, primaryIme)?.get(42)).toBe(
    "en_US",
  );
  adb.setCommandResponse("shell dumpsys package", {
    stdout: `Packages:\n  Package [com.example.primaryime] (abc):\n    versionName=15.2.0\nShared users:\n`,
    stderr: "",
  });
  const subtype = await catalog.readSubtype(primaryIme);
  expect(subtype).toEqual({ id: 42, locale: "en_US" });
  expect(await catalog.identity(primaryIme, subtype)).toEqual({
    component: primaryIme,
    package: "com.example.primaryime",
    versionName: "15.2.0",
    subtype: "en_US",
  });
  adb.setCommandResponse("shell dumpsys package", { stdout: "Packages:\n", stderr: "" });
  expect(await catalog.identity(primaryIme, { id: null })).toEqual({
    component: primaryIme,
    package: "com.example.primaryime",
  });
});

test("restores a selected subtype and deletes an unset one after verifying readback", async () => {
  const { adb, catalog } = fixture();
  adb.setCommandResponse("shell dumpsys input_method", {
    stdout: `mId=${primaryIme}\n  mSubtypeId=42 mSubtypeLocale=en_US`,
    stderr: "",
  });
  adb.setCommandResponseSequence("shell settings get secure selected_input_method_subtype", [
    { stdout: "42", stderr: "" },
    { stdout: "null", stderr: "" },
  ]);
  await catalog.restoreSubtypeWithinLock(primaryIme, { id: 42 });
  await catalog.restoreSubtypeWithinLock(primaryIme, { id: null });
  expect(adb.getExecutedArgv()).toContainEqual([
    "shell",
    "settings",
    "put",
    "secure",
    "selected_input_method_subtype",
    "42",
  ]);
  expect(adb.getExecutedArgv()).toContainEqual([
    "shell",
    "settings",
    "delete",
    "secure",
    "selected_input_method_subtype",
  ]);
});

test("rejects a subtype that is no longer advertised before writing it", async () => {
  const { adb, catalog } = fixture();
  adb.setCommandResponse("shell dumpsys input_method", {
    stdout: `mId=${primaryIme}\n  mSubtypeId=99 mSubtypeLocale=en_US`,
    stderr: "",
  });
  await expect(catalog.restoreSubtypeWithinLock(primaryIme, { id: 42 })).rejects.toThrow(
    "no longer advertised",
  );
  expect(
    adb
      .getExecutedCommands()
      .some((command) =>
        command.startsWith("shell settings put secure selected_input_method_subtype"),
      ),
  ).toBe(false);
});

function multiUser(foreground: number) {
  const adb = new FakeMultiUserImeAdb(foreground, [primaryIme, alternateIme]);
  adb.seedUser(0, { active: primaryIme });
  adb.seedUser(foreground, { active: primaryIme, enabled: [primaryIme, alternateIme] });
  const catalog = new AndroidImeCatalog(adb, `multi-user-${foreground}`, pinnedUser(foreground));
  return { adb, catalog };
}

function everyTargetsUser(calls: string[][], userId: number): boolean {
  return calls.every((args) => args.join(" ").includes(` --user ${userId}`));
}

test("a non-zero foreground user: list reads that user's active and enabled IMEs", async () => {
  const { adb, catalog } = multiUser(10);
  adb.state(0).active = "com.other/.UserZeroIme";

  const state = await catalog.list();

  expect(state.activeImeId).toBe(primaryIme);
  expect(state.installed.find((ime) => ime.id === alternateIme)?.enabled).toBe(true);
  expect(everyTargetsUser(adb.calls, 10)).toBe(true);
});

test("a non-zero foreground user: select applies and verifies the same user", async () => {
  const { adb, catalog } = multiUser(10);

  const state = await catalog.select(alternateIme);

  expect(state.activeImeId).toBe(alternateIme);
  expect(adb.state(10).active).toBe(alternateIme);
  expect(adb.state(0).active).toBe(primaryIme);
  expect(adb.calls).toContainEqual(["shell", "ime", "set", "--user", "10", alternateIme]);
  expect(everyTargetsUser(adb.calls, 10)).toBe(true);
});

test("a non-zero foreground user: scoped restore sends ime set when the temporary IME is active", async () => {
  const { adb, catalog } = multiUser(10);
  adb.state(10).active = alternateIme;

  const state = await catalog.selectWithinLock(primaryIme);

  expect(state.activeImeId).toBe(primaryIme);
  expect(adb.state(10).active).toBe(primaryIme);
});

test("a non-zero foreground user: subtype read and restore address that user only", async () => {
  const { adb, catalog } = multiUser(10);
  adb.state(10).subtype = "42";
  adb.state(0).subtype = "7";

  expect((await catalog.readSubtype(primaryIme)).id).toBe(42);
  await catalog.restoreSubtypeWithinLock(primaryIme, { id: null });

  expect(adb.state(10).subtype).toBeNull();
  expect(adb.state(0).subtype).toBe("7");
  expect(adb.calls).toContainEqual([
    "shell",
    "settings",
    "--user",
    "10",
    "delete",
    "secure",
    "selected_input_method_subtype",
  ]);
});

test("foreground user 0 keeps the exact pre-existing commands without --user", async () => {
  const { adb, catalog } = multiUser(0);
  adb.state(0).active = alternateIme;

  await catalog.selectWithinLock(primaryIme);
  await catalog.restoreSubtypeWithinLock(primaryIme, { id: 3 });

  expect(adb.calls.map((args) => args.join(" "))).toEqual([
    "shell ime list -a -s",
    "shell ime list -s",
    "shell settings get secure default_input_method",
    `shell ime set ${primaryIme}`,
    "shell ime list -a -s",
    "shell ime list -s",
    "shell settings get secure default_input_method",
    "shell dumpsys input_method",
    "shell settings put secure selected_input_method_subtype 3",
    "shell settings get secure selected_input_method_subtype",
  ]);
});

test("pinForeground keeps one user even if the foreground user changes afterwards", async () => {
  const adb = new FakeMultiUserImeAdb(10, [primaryIme, alternateIme]);
  adb.seedUser(10, { active: primaryIme, enabled: [primaryIme, alternateIme] });
  adb.seedUser(11, { active: primaryIme, enabled: [primaryIme, alternateIme] });
  let foreground = 10;
  const catalog = new AndroidImeCatalog(adb, "pin-device", {
    foregroundUserId: async () => foreground,
  });

  const pinned = await catalog.pinForeground();
  foreground = 11;
  await pinned.selectWithinLock(alternateIme);

  expect(adb.state(10).active).toBe(alternateIme);
  expect(adb.state(11).active).toBe(primaryIme);
});

test("foreground user comes from the shared resolver's current-user read", async () => {
  const adb = new FakeAdbExecutor();
  adb.setCommandResponse("shell am get-current-user", { stdout: "10\n", stderr: "" });

  expect(await createForegroundUserSource(adb).foregroundUserId()).toBe(10);
});

test("passes the dumpsys bound through fake exec and parses input_method above 1 MiB", async () => {
  // No input_method capture exists under test/fixtures. Pad the pre-existing
  // inline parser unit vector with synthetic feature-flag lines; this is not a capture.
  const padding = "  filler_feature_flag=true\n".repeat(50_000);
  const stdout = padding + ADVERTISED_SUBTYPE_UNIT_VECTOR + "\n" + padding;
  expect(Buffer.byteLength(stdout)).toBeGreaterThan(1024 * 1024);
  const timer = new FakeTimer();
  let dumpsysReads = 0;
  const adb = new AdbClient(
    null,
    async (_file, args, maxBuffer) => {
      if (args.join(" ") === "shell settings get secure selected_input_method_subtype") {
        expect(maxBuffer).toBeUndefined();
        return createExecResult("42", "");
      }
      expect(args).toEqual(["shell", "dumpsys", "input_method"]);
      expect(maxBuffer).toBe(DUMPSYS_MAX_BUFFER);
      expect(Buffer.byteLength(stdout)).toBeLessThanOrEqual(maxBuffer ?? 1024 * 1024);
      dumpsysReads += 1;
      return createExecResult(stdout, "");
    },
    null,
    new DefaultRetryExecutor(timer),
    timer,
  );
  expect(
    await new AndroidImeCatalog(adb, "large-ime-dump", pinnedUser(0)).readSubtype(primaryIme),
  ).toEqual({
    id: 42,
    locale: "en_US",
  });
  expect(dumpsysReads).toBe(1);
});

test.each([
  ["shell ime list -s", "list"],
  ["shell ime list -a -s", "list"],
  ["shell settings get secure default_input_method", "list"],
  ["shell settings get secure selected_input_method_subtype", "subtype"],
] as const)(
  "catalog retries %s once with a short per-command budget",
  async (command, operation) => {
    const { adb } = fixture();
    const optionsSeen: (AdbExecuteOptions | undefined)[] = [];
    const timer = new FakeTimer();
    let attempts = 0;
    const signal = new AbortController().signal;
    const catalog = new AndroidImeCatalog(
      {
        execute: async (args, options) => {
          if (args.join(" ") === command) {
            optionsSeen.push(options);
            if (++attempts === 1) {
              throw new AdbCommandTimeoutError("transient read timeout");
            }
          }
          return adb.execute(args, options);
        },
      },
      "read-retry",
      pinnedUser(0),
      new DefaultRetryExecutor(timer),
    );
    if (operation === "list") {
      await catalog.list(signal);
    } else {
      await catalog.readSubtype(primaryIme, signal);
    }
    expect(attempts).toBe(2);
    expect(optionsSeen).toEqual(Array(2).fill({ timeoutMs: 3_000, noRetry: true, signal }));
    expect(timer.getSleepHistory()).toEqual([]);
  },
);

test("catalog read retry is bounded and ignores non-timeout errors", async () => {
  for (const error of [
    new AdbCommandTimeoutError("still timed out"),
    new Error("permission denied"),
  ]) {
    let attempts = 0;
    const catalog = new AndroidImeCatalog(
      {
        execute: async () => {
          attempts++;
          throw error;
        },
      },
      "bounded-read",
      pinnedUser(0),
      new DefaultRetryExecutor(new FakeTimer()),
    );
    await expect(catalog.readSubtype(primaryIme)).rejects.toBe(error);
    expect(attempts).toBe(error instanceof AdbCommandTimeoutError ? 2 : 1);
  }
});

test.each(["set", "put", "delete"] as const)(
  "catalog never retries mutating %s on timeout",
  async (mutation) => {
    const { adb } = fixture();
    adb.setCommandResponse("shell ime list -s", {
      stdout: `${primaryIme}\n${alternateIme}`,
      stderr: "",
    });
    let attempts = 0;
    const error = new AdbCommandTimeoutError("mutation timed out");
    const catalog = new AndroidImeCatalog(
      {
        execute: async (args, options) => {
          if (args[2] === mutation) {
            attempts++;
            throw error;
          }
          return adb.execute(args, options);
        },
      },
      "mutation-timeout",
      pinnedUser(0),
      new DefaultRetryExecutor(new FakeTimer()),
    );
    const result =
      mutation === "set"
        ? catalog.selectWithinLock(alternateIme)
        : catalog.restoreSubtypeWithinLock(primaryIme, { id: mutation === "put" ? 42 : null });
    await expect(result).rejects.toBe(error);
    expect(attempts).toBe(1);
  },
);

test("catalog cancellation suppresses a read retry", async () => {
  const controller = new AbortController();
  let attempts = 0;
  const catalog = new AndroidImeCatalog(
    {
      execute: async () => {
        attempts++;
        controller.abort();
        throw new AdbCommandTimeoutError("read interrupted");
      },
    },
    "read-cancel",
    pinnedUser(0),
    new DefaultRetryExecutor(new FakeTimer()),
  );
  await expect(catalog.readSubtype(primaryIme, controller.signal)).rejects.toThrow();
  expect(attempts).toBe(1);
});

test("subtype restore verification retries its read without repeating the mutation", async () => {
  const { adb } = fixture();
  let reads = 0;
  const commands: string[] = [];
  const catalog = new AndroidImeCatalog(
    {
      execute: async (args, options) => {
        const command = args.join(" ");
        commands.push(command);
        if (
          command === "shell settings get secure selected_input_method_subtype" &&
          ++reads === 1
        ) {
          throw new AdbCommandTimeoutError("readback timeout");
        }
        return adb.execute(args, options);
      },
    },
    "restore-read-retry",
    pinnedUser(0),
    new DefaultRetryExecutor(new FakeTimer()),
  );
  await catalog.restoreSubtypeWithinLock(primaryIme, { id: null });
  expect(commands).toEqual([
    "shell settings delete secure selected_input_method_subtype",
    "shell settings get secure selected_input_method_subtype",
    "shell settings get secure selected_input_method_subtype",
  ]);
});
