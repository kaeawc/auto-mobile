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

const gboard =
  "com.google.android.inputmethod.latin/com.google.android.apps.inputmethod.latin.LatinIME";
const samsung = "com.samsung.android.honeyboard/.service.HoneyBoardService";

function fixture(deviceId = "test-device") {
  const adb = new FakeAdbExecutor();
  adb.setCommandResponse("shell ime list -a -s", { stdout: `${gboard}\n${samsung}\n`, stderr: "" });
  adb.setCommandResponse("shell ime list -s", { stdout: `${gboard}\n`, stderr: "" });
  adb.setCommandResponse("shell settings get secure default_input_method", {
    stdout: `${gboard}\n`,
    stderr: "",
  });
  return { adb, catalog: new AndroidImeCatalog(adb, deviceId, pinnedUser(0)) };
}

test("explicit selection recovers quarantine only after verified IME readback", async () => {
  const deviceId = "quarantined-select-success";
  const { adb, catalog } = fixture(deviceId);
  adb.setCommandResponse("shell ime list -s", { stdout: `${gboard}\n${samsung}\n`, stderr: "" });
  adb.setCommandResponseSequence("shell settings get secure default_input_method", [
    { stdout: gboard, stderr: "" },
    { stdout: samsung, stderr: "" },
  ]);
  quarantineAndroidIme(deviceId);

  expect((await catalog.select(samsung)).activeImeId).toBe(samsung);
  expect(adb.getExecutedArgv()).toContainEqual(["shell", "ime", "set", samsung]);
  expect(await withAndroidImeLock(deviceId, async () => "ordinary operation")).toBe(
    "ordinary operation",
  );
});

test("explicit selection of the already active IME recovers quarantine by readback", async () => {
  const deviceId = "quarantined-select-active";
  const { adb, catalog } = fixture(deviceId);
  quarantineAndroidIme(deviceId);

  expect((await catalog.select(gboard)).activeImeId).toBe(gboard);
  expect(adb.getExecutedCommands()).toContain("shell settings get secure default_input_method");
  expect(await withAndroidImeLock(deviceId, async () => true)).toBe(true);
});

test("mismatched selection readback leaves the device quarantined", async () => {
  const deviceId = "quarantined-select-mismatch";
  const { adb, catalog } = fixture(deviceId);
  adb.setCommandResponse("shell ime list -s", { stdout: `${gboard}\n${samsung}\n`, stderr: "" });
  quarantineAndroidIme(deviceId);

  await expect(catalog.select(samsung)).rejects.toThrow("did not take effect");
  expect(adb.getExecutedArgv()).toContainEqual(["shell", "ime", "set", samsung]);
  await expect(withAndroidImeLock(deviceId, async () => true)).rejects.toThrow(
    "IME state is unknown",
  );
});

test("failed ime set leaves the device quarantined and surfaces its error", async () => {
  const deviceId = "quarantined-select-failure";
  const { adb, catalog } = fixture(deviceId);
  adb.setCommandResponse("shell ime list -s", { stdout: `${gboard}\n${samsung}\n`, stderr: "" });
  adb.setCommandResponse(`shell ime set ${samsung}`, { stdout: "", stderr: "permission denied" });
  quarantineAndroidIme(deviceId);

  await expect(catalog.select(samsung)).rejects.toThrow(
    `Failed to select IME ${samsung}: permission denied`,
  );
  await expect(withAndroidImeLock(deviceId, async () => true)).rejects.toThrow(
    "IME state is unknown",
  );
});

test("failed selection readback leaves the device quarantined", async () => {
  const deviceId = "quarantined-select-readback-failure";
  const { adb, catalog } = fixture(deviceId);
  adb.setCommandResponse("shell ime list -s", { stdout: `${gboard}\n${samsung}\n`, stderr: "" });
  adb.setCommandResponseSequence("shell settings get secure default_input_method", [
    { stdout: gboard, stderr: "" },
    { stdout: "", stderr: "permission denied" },
  ]);
  quarantineAndroidIme(deviceId);

  await expect(catalog.select(samsung)).rejects.toThrow(
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

  expect((await catalog.selectWithinLock(gboard)).activeImeId).toBe(gboard);
  await expect(withAndroidImeLock(deviceId, async () => true)).rejects.toThrow(
    "IME state is unknown",
  );
});

test("quarantined explicit selection holds the lock until readback before an ordinary operation", async () => {
  const deviceId = "quarantined-select-serialization";
  const { adb } = fixture(deviceId);
  adb.setCommandResponse("shell ime list -s", { stdout: `${gboard}\n${samsung}\n`, stderr: "" });
  adb.setCommandResponseSequence("shell settings get secure default_input_method", [
    { stdout: gboard, stderr: "" },
    { stdout: samsung, stderr: "" },
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
        if (args.join(" ") === `shell ime set ${samsung}`) {
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
  const selection = catalog.select(samsung);
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
    activeImeId: gboard,
    installed: [
      { id: gboard, enabled: true, active: true, capabilities: imeCapabilities(gboard) },
      { id: samsung, enabled: false, active: false, capabilities: imeCapabilities(samsung) },
    ],
  });
});

test("select rejects an unknown or disabled IME before running ime set", async () => {
  const { adb, catalog } = fixture();
  await expect(catalog.select("com.example/.Injected;echo bad")).rejects.toThrow("not installed");
  await expect(catalog.select(samsung)).rejects.toThrow("installed but disabled");
  expect(adb.getExecutedCommands().some((command) => command.startsWith("shell ime set"))).toBe(
    false,
  );
});

test("select uses component argv and verifies the resulting active IME", async () => {
  const { adb, catalog } = fixture();
  adb.setCommandResponse("shell ime list -s", { stdout: `${gboard}\n${samsung}\n`, stderr: "" });
  adb.setCommandResponseSequence("shell settings get secure default_input_method", [
    { stdout: gboard, stderr: "" },
    { stdout: samsung, stderr: "" },
  ]);
  expect((await catalog.select(samsung)).activeImeId).toBe(samsung);
  expect(adb.getExecutedArgv()).toContainEqual(["shell", "ime", "set", samsung]);
  expect(
    adb.getCommandCalls().find((call) => call.command === `shell ime set ${samsung}`)
      ?.waitForProcessSettlementAfterAbort,
  ).toBe(true);
  expect(
    adb.getCommandCalls().find((call) => call.command === `shell ime set ${samsung}`)?.timeoutMs,
  ).toBe(5_000);
});

test("select reports a failed postcondition instead of claiming readiness", async () => {
  const { adb, catalog } = fixture();
  adb.setCommandResponse("shell ime list -s", { stdout: `${gboard}\n${samsung}\n`, stderr: "" });
  await expect(catalog.select(samsung)).rejects.toThrow("did not take effect");
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
  const selection = catalog.select(gboard);
  await Promise.resolve();
  expect(adb.getExecutedArgv()).toEqual([]);
  release();
  await inFlight;
  expect((await selection).activeImeId).toBe(gboard);
});

test("reports the verified IME after cancellation following set dispatch", async () => {
  const { adb } = fixture();
  const controller = new AbortController();
  adb.setCommandResponse("shell ime list -s", { stdout: `${gboard}\n${samsung}\n`, stderr: "" });
  adb.setCommandResponseSequence("shell settings get secure default_input_method", [
    { stdout: gboard, stderr: "" },
    { stdout: samsung, stderr: "" },
  ]);
  const catalog = new AndroidImeCatalog(
    {
      execute: async (args: string[], options?: AdbExecuteOptions) => {
        if (args.join(" ") !== `shell ime set ${samsung}`) {
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

  expect((await catalog.selectWithinLock(samsung, controller.signal)).activeImeId).toBe(samsung);
});

test("reports a genuine set failure after cancellation following dispatch", async () => {
  const { adb } = fixture();
  const controller = new AbortController();
  adb.setCommandResponse("shell ime list -s", { stdout: `${gboard}\n${samsung}\n`, stderr: "" });
  const catalog = new AndroidImeCatalog(
    {
      execute: async (args: string[], options?: AdbExecuteOptions) => {
        if (args.join(" ") !== `shell ime set ${samsung}`) {
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
  adb.setCommandResponse(`shell ime set ${samsung}`, { stdout: "", stderr: "permission denied" });

  await expect(catalog.selectWithinLock(samsung, controller.signal)).rejects.toThrow(
    "Failed to select IME",
  );
});

test("cancels set before dispatch without changing the active IME", async () => {
  const { adb } = fixture();
  const controller = new AbortController();
  adb.setCommandResponse("shell ime list -s", { stdout: `${gboard}\n${samsung}\n`, stderr: "" });
  let dispatched = false;
  let enteredQueue: () => void = () => {};
  const queued = new Promise<void>((resolve) => {
    enteredQueue = resolve;
  });
  const catalog = new AndroidImeCatalog(
    {
      execute: async (args: string[], options?: AdbExecuteOptions) => {
        if (args.join(" ") !== `shell ime set ${samsung}`) {
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

  const selection = catalog.selectWithinLock(samsung, controller.signal);
  await queued;
  controller.abort();
  await expect(selection).rejects.toThrow();
  expect(dispatched).toBe(false);
  expect(adb.getExecutedArgv()).not.toContainEqual(["shell", "ime", "set", samsung]);
});

test("reports static capabilities for installed and AutoMobile IMEs", () => {
  expect(imeCapabilities(gboard)).toEqual({
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
  const dump = `mId=${gboard}Extra\n  mSubtypeId=42 mSubtypeLocale=wrong\nmId=${gboard}\n  mSubtypeId=-42 mSubtypeLocale=en_US`;
  expect(parseAdvertisedImeSubtypes(dump, gboard)?.get(-42)).toBe("en_US");
  expect(parseAdvertisedImeSubtypes(dump, gboard)?.has(42)).toBe(false);
});

test("finds only the target package version in realistic multi-package dumpsys output", () => {
  const dump = `Packages:
  Package [com.example.other] (8765):
    userId=10001
    pkg=Package{123 com.example.other}
    versionCode=11 minSdk=23 targetSdk=35
    versionName=9.9.9
  Package [com.google.android.inputmethod.latin] (4321):
    userId=10002
    pkg=Package{456 com.google.android.inputmethod.latin}
    versionCode=150000 minSdk=23 targetSdk=35
    versionName=15.2.08.677488654-release-arm64-v8a
    signatures=PackageSignatures{abc}
Shared users:
  SharedUser [android.uid.system] (123):
    versionName=unrelated
Dexopt state:
  [com.google.android.inputmethod.latin]
    versionName=also-unrelated`;
  expect(parsePackageVersionName(dump, "com.google.android.inputmethod.latin")).toBe(
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
    stdout: `mId=${gboard}\n  mSubtypeId=42 mSubtypeLocale=en_US\nmId=${samsung}\n  mSubtypeId=42 mSubtypeLocale=ko_KR`,
    stderr: "",
  });
  expect(
    parseAdvertisedImeSubtypes(
      `mId=${gboard}\n  mSubtypeId=42 mSubtypeLocale=en_US\nmId=${samsung}\n  mSubtypeId=42 mSubtypeLocale=ko_KR`,
      gboard,
    )?.get(42),
  ).toBe("en_US");
  adb.setCommandResponse("shell dumpsys package", {
    stdout: `Packages:\n  Package [com.google.android.inputmethod.latin] (abc):\n    versionName=15.2.0\nShared users:\n`,
    stderr: "",
  });
  const subtype = await catalog.readSubtype(gboard);
  expect(subtype).toEqual({ id: 42, locale: "en_US" });
  expect(await catalog.identity(gboard, subtype)).toEqual({
    component: gboard,
    package: "com.google.android.inputmethod.latin",
    versionName: "15.2.0",
    subtype: "en_US",
  });
  adb.setCommandResponse("shell dumpsys package", { stdout: "Packages:\n", stderr: "" });
  expect(await catalog.identity(gboard, { id: null })).toEqual({
    component: gboard,
    package: "com.google.android.inputmethod.latin",
  });
});

test("restores a selected subtype and deletes an unset one after verifying readback", async () => {
  const { adb, catalog } = fixture();
  adb.setCommandResponse("shell dumpsys input_method", {
    stdout: `mId=${gboard}\n  mSubtypeId=42 mSubtypeLocale=en_US`,
    stderr: "",
  });
  adb.setCommandResponseSequence("shell settings get secure selected_input_method_subtype", [
    { stdout: "42", stderr: "" },
    { stdout: "null", stderr: "" },
  ]);
  await catalog.restoreSubtypeWithinLock(gboard, { id: 42 });
  await catalog.restoreSubtypeWithinLock(gboard, { id: null });
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
    stdout: `mId=${gboard}\n  mSubtypeId=99 mSubtypeLocale=en_US`,
    stderr: "",
  });
  await expect(catalog.restoreSubtypeWithinLock(gboard, { id: 42 })).rejects.toThrow(
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
  const adb = new FakeMultiUserImeAdb(foreground, [gboard, samsung]);
  adb.seedUser(0, { active: gboard });
  adb.seedUser(foreground, { active: gboard, enabled: [gboard, samsung] });
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

  expect(state.activeImeId).toBe(gboard);
  expect(state.installed.find((ime) => ime.id === samsung)?.enabled).toBe(true);
  expect(everyTargetsUser(adb.calls, 10)).toBe(true);
});

test("a non-zero foreground user: select applies and verifies the same user", async () => {
  const { adb, catalog } = multiUser(10);

  const state = await catalog.select(samsung);

  expect(state.activeImeId).toBe(samsung);
  expect(adb.state(10).active).toBe(samsung);
  expect(adb.state(0).active).toBe(gboard);
  expect(adb.calls).toContainEqual(["shell", "ime", "set", "--user", "10", samsung]);
  expect(everyTargetsUser(adb.calls, 10)).toBe(true);
});

test("a non-zero foreground user: scoped restore sends ime set when the temporary IME is active", async () => {
  const { adb, catalog } = multiUser(10);
  adb.state(10).active = samsung;

  const state = await catalog.selectWithinLock(gboard);

  expect(state.activeImeId).toBe(gboard);
  expect(adb.state(10).active).toBe(gboard);
});

test("a non-zero foreground user: subtype read and restore address that user only", async () => {
  const { adb, catalog } = multiUser(10);
  adb.state(10).subtype = "42";
  adb.state(0).subtype = "7";

  expect((await catalog.readSubtype(gboard)).id).toBe(42);
  await catalog.restoreSubtypeWithinLock(gboard, { id: null });

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
  adb.state(0).active = samsung;

  await catalog.selectWithinLock(gboard);
  await catalog.restoreSubtypeWithinLock(gboard, { id: 3 });

  expect(adb.calls.map((args) => args.join(" "))).toEqual([
    "shell ime list -a -s",
    "shell ime list -s",
    "shell settings get secure default_input_method",
    `shell ime set ${gboard}`,
    "shell ime list -a -s",
    "shell ime list -s",
    "shell settings get secure default_input_method",
    "shell dumpsys input_method",
    "shell settings put secure selected_input_method_subtype 3",
    "shell settings get secure selected_input_method_subtype",
  ]);
});

test("pinForeground keeps one user even if the foreground user changes afterwards", async () => {
  const adb = new FakeMultiUserImeAdb(10, [gboard, samsung]);
  adb.seedUser(10, { active: gboard, enabled: [gboard, samsung] });
  adb.seedUser(11, { active: gboard, enabled: [gboard, samsung] });
  let foreground = 10;
  const catalog = new AndroidImeCatalog(adb, "pin-device", {
    foregroundUserId: async () => foreground,
  });

  const pinned = await catalog.pinForeground();
  foreground = 11;
  await pinned.selectWithinLock(samsung);

  expect(adb.state(10).active).toBe(samsung);
  expect(adb.state(11).active).toBe(gboard);
});

test("foreground user comes from the shared resolver's current-user read", async () => {
  const adb = new FakeAdbExecutor();
  adb.setCommandResponse("shell am get-current-user", { stdout: "10\n", stderr: "" });

  expect(await createForegroundUserSource(adb).foregroundUserId()).toBe(10);
});
