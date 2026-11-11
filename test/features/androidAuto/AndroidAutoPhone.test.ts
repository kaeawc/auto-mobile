import { describe, expect, test } from "bun:test";
import {
  AdbAndroidAutoPhone,
  type AndroidAutoPhoneAdb,
} from "../../../src/features/androidAuto/AndroidAutoPhone";
import {
  ANDROID_AUTO_NOTIFICATION_LISTENER,
  ANDROID_AUTO_PACKAGE,
} from "../../../src/features/androidAuto/androidAutoProjection";
import { ActionableError, type ExecResult } from "../../../src/models";

const result = (stdout: string, extra: Partial<ExecResult> = {}): ExecResult => ({
  stdout,
  stderr: "",
  toString: () => stdout,
  trim: () => stdout.trim(),
  includes: (search: string) => stdout.includes(search),
  ...extra,
});

class RecordingAdb implements AndroidAutoPhoneAdb {
  readonly calls: string[][] = [];
  constructor(private readonly reply: (args: string[]) => ExecResult | Error = () => result("")) {}

  async execute(args: string[]): Promise<ExecResult> {
    this.calls.push(args);
    const reply = this.reply(args);
    if (reply instanceof Error) {
      throw reply;
    }
    return reply;
  }
}

describe("AdbAndroidAutoPhone queries", () => {
  test.each([
    ["isAndroidAutoSideloaded", "pm path"],
    ["isKeyguardDisabled", "locksettings get-disabled"],
    ["isStayOnEnabled", "stay_on_while_plugged_in"],
    ["isNotificationListenerAllowed", "enabled_notification_listeners"],
    ["isHeadUnitServerListening", ":5277 "],
  ] as const)("%s answers from the script's own yes/no token", async (method, fragment) => {
    const yes = new RecordingAdb(() => result("yes\n"));
    const no = new RecordingAdb(() => result("no\n"));
    expect(await new AdbAndroidAutoPhone(yes)[method]()).toBe(true);
    expect(await new AdbAndroidAutoPhone(no)[method]()).toBe(false);
    expect(yes.calls[0][0]).toBe("shell");
    expect(yes.calls[0][1]).toContain(fragment);
    expect(yes.calls[0][1]).toMatch(/then echo yes; else echo no; fi$/);
  });

  test("the notification check single-quotes the listener so the device shell keeps $", async () => {
    const adb = new RecordingAdb(() => result("yes"));
    await new AdbAndroidAutoPhone(adb).isNotificationListenerAllowed();
    expect(adb.calls[0][1]).toContain(`'${ANDROID_AUTO_NOTIFICATION_LISTENER}'`);
  });
});

describe("AdbAndroidAutoPhone adbState", () => {
  test("reports adb get-state's state", async () => {
    const adb = new RecordingAdb(() => result("device\n"));
    expect(await new AdbAndroidAutoPhone(adb).adbState()).toBe("device");
    expect(adb.calls).toEqual([["get-state"]]);
  });

  test("reports the error adb exits with while the emulator is offline", async () => {
    const adb = new RecordingAdb(() => new Error("error: device offline"));
    expect(await new AdbAndroidAutoPhone(adb).adbState()).toContain("device offline");
  });

  test("rejects on abort instead of reporting a state", async () => {
    const controller = new AbortController();
    const adb = new RecordingAdb(() => {
      controller.abort(new Error("deadline"));
      return new Error("aborted");
    });
    await expect(new AdbAndroidAutoPhone(adb).adbState(controller.signal)).rejects.toThrow(
      "deadline",
    );
  });
});

describe("AdbAndroidAutoPhone mutations", () => {
  test("installs the split APKs as one replacing install-multiple", async () => {
    const adb = new RecordingAdb(() => result("Success\n"));
    await new AdbAndroidAutoPhone(adb).installSplitApks([
      "/apks/base.apk",
      "/apks/split_config.en.apk",
    ]);
    expect(adb.calls).toEqual([
      ["install-multiple", "-r", "/apks/base.apk", "/apks/split_config.en.apk"],
    ]);
  });

  test("an install without Success is an actionable error", async () => {
    const adb = new RecordingAdb(() => result("", { stderr: "rejected" }));
    const install = new AdbAndroidAutoPhone(adb).installSplitApks(["/apks/base.apk"]);
    await expect(install).rejects.toBeInstanceOf(ActionableError);
    await expect(install).rejects.toThrow("rejected");
  });

  test("a failed adb call is wrapped with the step it belonged to", async () => {
    const adb = new RecordingAdb(() => new Error("device offline"));
    await expect(new AdbAndroidAutoPhone(adb).disableKeyguard()).rejects.toThrow(
      "locksettings set-disabled failed",
    );
  });

  test("issues the shell commands verified on device", async () => {
    const adb = new RecordingAdb();
    const phone = new AdbAndroidAutoPhone(adb);
    await phone.disableKeyguard();
    await phone.enableStayOn();
    await phone.allowNotificationListener();
    await phone.openAndroidAutoSettings();
    await phone.forceStopAndroidAuto();
    expect(adb.calls.map((args) => args[1])).toEqual([
      "locksettings set-disabled true",
      "svc power stayon true",
      `cmd notification allow_listener '${ANDROID_AUTO_NOTIFICATION_LISTENER}'`,
      `am start -a com.android.settings.action.IA_SETTINGS -p ${ANDROID_AUTO_PACKAGE}`,
      `am force-stop ${ANDROID_AUTO_PACKAGE}`,
    ]);
  });

  test("adds the head unit redirect on the emulator console", async () => {
    const adb = new RecordingAdb();
    await new AdbAndroidAutoPhone(adb).addHeadUnitRedirect();
    expect(adb.calls).toEqual([["emu", "redir", "add", "tcp:5277:5277"]]);
  });

  test("removes the head unit redirect on the emulator console", async () => {
    const adb = new RecordingAdb();
    await new AdbAndroidAutoPhone(adb).removeHeadUnitRedirect();
    expect(adb.calls).toEqual([["emu", "redir", "del", "tcp:5277"]]);
  });

  test("a redirect removal the console refuses is an actionable error", async () => {
    const adb = new RecordingAdb(() => result("KO: unknown redirect", {}));
    await expect(new AdbAndroidAutoPhone(adb).removeHeadUnitRedirect()).rejects.toThrow(
      "adb emu redir del tcp:5277 failed",
    );
  });

  test("a redirect the console refuses names the emulator requirement", async () => {
    const adb = new RecordingAdb(() => result("", { error: "no emulator console" }));
    await expect(new AdbAndroidAutoPhone(adb).addHeadUnitRedirect()).rejects.toThrow(
      "The redirect needs an emulator",
    );
  });
});
