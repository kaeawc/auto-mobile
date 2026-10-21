import { describe, expect, test } from "bun:test";
import { AndroidDeviceMutationResetPort } from "../../../src/daemon/sessionBroker/androidDeviceMutationResetPort";
import { ANDROID_CERTIFIABLE_KINDS } from "../../../src/daemon/sessionBroker/androidMutationBaseline";
import {
  DEVICE_MUTATION_KINDS,
  type DeviceBaseline,
} from "../../../src/daemon/sessionBroker/mutations/types";
import { diffDeviceBaseline } from "../../../src/daemon/sessionBroker/mutations/baseline";
import { planDeviceMutationRevert } from "../../../src/daemon/sessionBroker/mutations/revertPlanner";
import { readFileSync } from "node:fs";
import { androidBaselineRig, androidPackageDump } from "./fixtures/androidMutationBaseline";

function rig(users: readonly number[] = [0]) {
  const { adb, reply } = androidBaselineRig(users);
  const port = new AndroidDeviceMutationResetPort(adb);
  const context = {
    scope: { deviceId: "emulator-5554", incarnation: "resource-a", sessionUuid: "session-a" },
    signal: new AbortController().signal,
    assertOwned: async () => {},
  };
  return { adb, reply, port, context };
}

const observation = (snapshot: DeviceBaseline, kind: string, key: string) =>
  snapshot.observations.find((entry) => entry.kind === kind && entry.key === key)?.value;

describe("Android mutation baseline capture", () => {
  test("captures third-party state while preserving system package membership without per-package dumps", async () => {
    const { port, context, reply, adb } = rig();
    const fixture = (name: string) =>
      readFileSync(
        new URL(`../../fixtures/android-dumpsys-package/${name}.txt`, import.meta.url),
        "utf8",
      );
    reply(
      "shell pm list packages --user 0",
      "package:android\npackage:com.android.egg\npackage:dev.jasonpearson.automobile.playground",
    );
    reply("shell pm list packages -3 --user 0", "package:dev.jasonpearson.automobile.playground");
    reply("shell pm list packages -s -u", "package:android\npackage:com.android.egg");
    reply("shell dumpsys package 'com.android.egg'", fixture("dumpsys-package-system-installed"));
    reply(
      "shell dumpsys package 'dev.jasonpearson.automobile.playground'",
      fixture("dumpsys-package-installed"),
    );
    const baseline = await port.capture(context);
    expect(observation(baseline, "installed-app", "user:0:com.android.egg")).toEqual({
      state: "present",
      value: true,
    });
    expect(observation(baseline, "installed-app", "identity:com.android.egg")).toBeUndefined();
    expect(
      observation(
        baseline,
        "permission",
        "runtime:0:com.android.egg:android.permission.POST_NOTIFICATIONS",
      ),
    ).toBeUndefined();
    expect(
      observation(baseline, "installed-app", "user:0:dev.jasonpearson.automobile.playground"),
    ).toEqual({ state: "present", value: true });
    expect(adb.getExecutedCommands()).not.toContain("shell dumpsys package 'android'");
    expect(adb.getExecutedCommands()).not.toContain("shell dumpsys package 'com.android.egg'");
  });

  test("captures all package membership and third-party runtime grants for all users", async () => {
    const { adb, port, context, reply } = rig([0, 10]);
    reply(
      "shell dumpsys package 'android'",
      androidPackageDump("android", [0, 10]).replace(
        /granted=true, flags/g,
        "granted=false, flags",
      ),
    );
    const baseline = await port.capture(context);
    for (const user of [0, 10]) {
      expect(adb.getExecutedCommands()).toContain(`shell pm list packages -3 --user ${user}`);
      expect(observation(baseline, "installed-app", `user:${user}:com.example.probe`)).toEqual({
        state: "present",
        value: true,
      });
      expect(
        observation(baseline, "permission", `runtime:${user}:android:android.permission.CAMERA`),
      ).toBeUndefined();
      expect(
        observation(
          baseline,
          "permission",
          `runtime:${user}:com.example.probe:android.permission.CAMERA`,
        ),
      ).toEqual({ state: "present", value: true });
      expect(
        observation(
          baseline,
          "permission",
          `runtime-flags:${user}:com.example.probe:android.permission.CAMERA`,
        ),
      ).toMatchObject({ state: "present", value: expect.stringContaining("USER_SET") });
    }
    expect(adb.getExecutedCommands()).toContain("shell pm list packages -s -u");
    expect(observation(baseline, "device-setting", "display:density")).toEqual({
      state: "present",
      value: "480",
    });
    expect(observation(baseline, "device-setting", "display:size")).toEqual({ state: "absent" });
    expect(observation(baseline, "device-setting", "system:user:10:font_scale")).toEqual({
      state: "present",
      value: "1.0",
    });
    expect(observation(baseline, "device-setting", "locale")).toEqual({
      state: "present",
      value: "en-US",
    });
  });

  test("certifies only complete kinds and explains blind spots without weakening clean certification", async () => {
    const { port, context } = rig();
    const baseline = await port.capture(context);
    expect(baseline.completeKinds).toEqual([...ANDROID_CERTIFIABLE_KINDS]);
    expect(port.certifiableKinds).toEqual(baseline.completeKinds);
    expect(baseline.unobservable).toEqual(
      DEVICE_MUTATION_KINDS.filter((kind) => !baseline.completeKinds.includes(kind)),
    );
    for (const kind of baseline.unobservable) {
      expect(baseline.unobservableReasons?.[kind]).toBeTruthy();
    }
    expect(baseline.unobservableReasons?.permission).toContain("AppOps");
    expect(baseline.unobservableReasons?.["shared-file"]).toContain("secondary-user");
    const diff = diffDeviceBaseline(baseline, baseline);
    expect(planDeviceMutationRevert([], diff, port).status).toBe("non_revertible");
    expect(diff.dirty).toContain("baseline: unobservable clipboard");
    expect(diff.dirty).toContain("baseline: unobservable installed-app");
  });

  test("every observation command is ownership-fenced, abortable, bounded and send-once", async () => {
    const { adb, port, context } = rig();
    let fences = 0;
    context.assertOwned = async () => {
      fences++;
    };
    await port.capture(context);
    const calls = adb.getCommandCalls();
    expect(fences).toBe(calls.length * 2);
    for (const call of calls) {
      expect(call).toMatchObject({
        signal: context.signal,
        maxBuffer: 4 * 1024 * 1024,
        noRetry: true,
        waitForProcessSettlementAfterAbort: true,
      });
      expect(call.timeoutMs).toBeGreaterThan(0);
      expect(call.timeoutMs).toBeLessThanOrEqual(30_000);
    }
  });

  test("ownership loss stops inventory before another command is dispatched", async () => {
    const { adb, port, context } = rig();
    let fences = 0;
    context.assertOwned = async () => {
      if (++fences === 3) {
        throw new Error("ownership lost");
      }
    };
    await expect(port.capture(context)).rejects.toThrow("ownership lost");
    expect(adb.getExecutedCommands()).toEqual(["shell pm list users"]);
  });

  test("full settings dumps retain untracked keys, equals, literal null, whitespace and user scope", async () => {
    const { port, context, reply } = rig([0, 10]);
    reply("shell settings --user 0 list global", "untracked_key= a=b \nliteral_null=null\nempty=");
    reply(
      "shell settings --user 10 list secure",
      "enabled_input_methods=Error: a literal setting value",
    );
    const baseline = await port.capture(context);
    expect(observation(baseline, "device-setting", "global:untracked_key")).toEqual({
      state: "present",
      value: " a=b ",
    });
    expect(observation(baseline, "device-setting", "global:literal_null")).toEqual({
      state: "present",
      value: "null",
    });
    expect(observation(baseline, "device-setting", "global:empty")).toEqual({
      state: "present",
      value: "",
    });
    expect(observation(baseline, "device-setting", "secure:user:10:enabled_input_methods")).toEqual(
      { state: "present", value: "Error: a literal setting value" },
    );
    expect(observation(baseline, "device-setting", "secure:default_input_method")).toBeUndefined();
  });

  test("diffs unknown settings additions, removals and edits and plans put/delete restoration", async () => {
    const { port, context, reply, adb } = rig([0, 10]);
    reply("shell settings --user 10 list secure", "unknown=old\nremoved=prior");
    const baseline = await port.capture(context);
    reply("shell settings --user 10 list secure", "unknown=new\nadded=value");
    const diff = diffDeviceBaseline(baseline, await port.capture(context));
    const changes = diff.changes.filter((change) => change.kind === "device-setting");
    const plan = planDeviceMutationRevert([], { dirty: [], changes }, port);
    expect(plan.status).toBe("revertible");
    if (plan.status !== "revertible") {
      throw new Error("Expected settings-only plan");
    }
    adb.clearHistory();
    for (const step of plan.steps) {
      await port.revert(step.mutation, context);
    }
    expect(adb.getExecutedCommands()).toEqual([
      "shell settings --user 10 put secure unknown 'old'",
      "shell settings --user 10 put secure removed 'prior'",
      "shell settings --user 10 delete secure added",
    ]);
  });

  test.each(["com.example.probe"])(
    "detects a non-restorable third-party update of %s",
    async (name) => {
      const { port, context, reply } = rig();
      const baseline = await port.capture(context);
      reply(
        `shell dumpsys package '${name}'`,
        androidPackageDump(name).replace("lastUpdateTime=2026-10-20", "lastUpdateTime=2026-10-21"),
      );
      const diff = diffDeviceBaseline(baseline, await port.capture(context));
      const changes = diff.changes.filter((change) => change.kind === "installed-app");
      expect(changes).toHaveLength(1);
      expect(changes[0]?.key).toBe(`identity:${name}`);
      expect(planDeviceMutationRevert([], { dirty: [], changes }, port).status).toBe(
        "non_revertible",
      );
    },
  );

  test("skips dumps of system packages uninstalled for every user", async () => {
    const { port, context, reply, adb } = rig();
    reply("shell pm list packages -s -u", "package:android\npackage:com.android.hidden");
    reply(
      "shell dumpsys package 'com.android.hidden'",
      androidPackageDump("com.android.hidden", []).replace(
        "/data/app/~~token/com.android.hidden-token",
        "/system/app/Hidden",
      ),
    );
    const baseline = await port.capture(context);
    expect(observation(baseline, "installed-app", "identity:com.android.hidden")).toBeUndefined();
    expect(adb.getExecutedCommands()).not.toContain("shell dumpsys package 'com.android.hidden'");
    expect(observation(baseline, "installed-app", "user:0:com.android.hidden")).toBeUndefined();
  });

  test("new package grants and identity are covered by user-scoped uninstall, not unsupported grant restoration", async () => {
    const { port, context, reply } = rig([0, 10]);
    const baseline = await port.capture(context);
    reply(
      "shell pm list packages --user 10",
      "package:android\npackage:com.example.probe\npackage:com.example.external",
    );
    reply(
      "shell pm list packages -3 --user 10",
      "package:com.example.probe\npackage:com.example.external",
    );
    reply(
      "shell dumpsys package 'com.example.external'",
      androidPackageDump("com.example.external", [10]),
    );
    const diff = diffDeviceBaseline(baseline, await port.capture(context));
    const plan = planDeviceMutationRevert([], { dirty: [], changes: diff.changes }, port);
    expect(plan.status).toBe("revertible");
    if (plan.status !== "revertible") {
      throw new Error("Expected added-package plan");
    }
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]?.mutation).toMatchObject({
      kind: "installed-app",
      key: "user:10:com.example.external",
      priorValue: { state: "absent" },
    });
  });

  test("changed account digest is dirty and non-revertible; private account names are not persisted", async () => {
    const { port, context, reply } = rig([0, 10]);
    const baseline = await port.capture(context);
    reply(
      "shell dumpsys account",
      "User UserInfo{0:Owner:c13}:\n  Accounts: 0\nUser UserInfo{10:Work:c13}:\n  Accounts: 1\n    Account {name=private@example.com, type=example}",
    );
    const current = await port.capture(context);
    expect(JSON.stringify(current)).not.toContain("private@example.com");
    expect(observation(current, "account", "inventory")).toMatchObject({
      state: "present",
      value: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const changes = diffDeviceBaseline(baseline, current).changes;
    expect(changes).toHaveLength(1);
    expect(changes[0]?.kind).toBe("account");
    expect(planDeviceMutationRevert([], { dirty: [], changes }, port).status).toBe(
      "non_revertible",
    );
  });

  test("hashes file contents and literal filenames rather than silently accepting overwritten baseline files", async () => {
    const { adb, port, context, reply } = rig();
    await port.capture(context);
    const command = adb
      .getExecutedCommands()
      .find((entry) => entry.includes("find") && entry.includes("/sdcard/DCIM"))!;
    const path = "/sdcard/DCIM/error: exception not supported no such file.jpg";
    reply(command, `${"a".repeat(64)}  ${path}`);
    const before = await port.capture(context);
    reply(command, `${"b".repeat(64)}  ${path}`);
    const after = await port.capture(context);
    expect(diffDeviceBaseline(before, after).changes).toContainEqual({
      kind: "shared-file",
      key: path,
      priorValue: { state: "present", value: "a".repeat(64) },
      currentValue: { state: "present", value: "b".repeat(64) },
      journaled: false,
    });
    expect(adb.getCommandCalls().filter((options) => options.timeoutMs === 30_000)).toHaveLength(
      15,
    );
  });

  test("inventories all top-level shared-storage roots, including roots outside the hashed subset", async () => {
    const { port, context, reply } = rig();
    reply(
      "shell find /sdcard/ -mindepth 1 -maxdepth 1 -print",
      "/sdcard/Download\n/sdcard/Android\n/sdcard/Music",
    );
    const baseline = await port.capture(context);
    reply(
      "shell find /sdcard/ -mindepth 1 -maxdepth 1 -print",
      "/sdcard/Music\n/sdcard/Android\n/sdcard/Download",
    );
    expect(diffDeviceBaseline(baseline, await port.capture(context)).changes).toHaveLength(0);
    reply(
      "shell find /sdcard/ -mindepth 1 -maxdepth 1 -print",
      "/sdcard/Download\n/sdcard/Android\n/sdcard/Music\n/sdcard/External",
    );
    expect(diffDeviceBaseline(baseline, await port.capture(context)).changes).toMatchObject([
      { kind: "shared-file", key: "roots" },
    ]);
  });

  test.each([
    ["shell pm list users", "Users:\nUserInfo{0:Owner:c13} running\nError: denied"],
    ["shell pm list users", "Users:\nUserInfo{0:Owner:c13}\nUserInfo{0:Owner:c13}"],
    ["shell pm list packages --user 0", ""],
    ["shell pm list packages -s -u", ""],
    ["shell pm list packages -3 --user 0", "package:invalid;rm -rf /"],
    ["shell pm list packages -3 --user 0", "package:com.example.missing"],
    ["shell dumpsys package 'com.example.probe'", "unreadable"],
    ["shell settings --user 0 list global", "Error: denied"],
    ["shell settings --user 0 list global", "key=1\nkey=2"],
    ["shell settings --user 0 list global", "--user=value"],
    ["shell find /sdcard/ -mindepth 1 -maxdepth 1 -print", "/sdcard/../data"],
    ["shell dumpsys account", "Accounts: 0"],
    ["shell wm density", "unknown density"],
    ["shell wm size", "Physical size: 1080x1920\nOverride size: bogus"],
    ["shell cmd uimode night", "Night mode: unknown"],
  ])("rejects unreadable inventory from %s: %s", async (command, stdout) => {
    const { port, context, reply } = rig();
    reply(command, stdout);
    await expect(port.capture(context)).rejects.toThrow();
  });
});
