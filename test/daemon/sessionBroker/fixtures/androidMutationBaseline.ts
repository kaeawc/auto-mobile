import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { createExecResult } from "../../../../src/utils/execResult";

export function androidPackageDump(name: string, users: readonly number[] = [0]): string {
  return `Packages:
  Package [${name}] (a12f03):
    userId=10123
    codePath=${name === "android" ? "/system/framework/framework-res.apk" : `/data/app/~~token/${name}-token`}
    versionCode=42 minSdk=23 targetSdk=35
    firstInstallTime=2026-10-20 09:10:11
    lastUpdateTime=2026-10-20 09:10:11
    requested permissions:
      android.permission.CAMERA
    install permissions:
      android.permission.INTERNET: granted=true
${users
  .map(
    (
      user,
    ) => `    User ${user}: ceDataInode=123 installed=true hidden=false suspended=false stopped=false notLaunched=false enabled=0
      runtime permissions:
        android.permission.CAMERA: granted=true, flags=[ USER_SET ]`,
  )
  .join("\n")}`;
}

export function androidBaselineRig(users: readonly number[] = [0]) {
  const adb = new FakeAdbExecutor();
  const reply = (command: string, stdout: string) =>
    adb.setCommandResponse(command, createExecResult(stdout, ""));
  reply(
    "shell pm list users",
    `Users:\n${users.map((user) => `\tUserInfo{${user}:${user === 0 ? "Owner" : "Work profile"}:c13} running`).join("\n")}`,
  );
  reply("shell pm list packages -s -u", "package:android");
  for (const user of users) {
    reply(`shell pm list packages --user ${user}`, "package:android\npackage:com.example.probe");
    reply(`shell pm list packages -3 --user ${user}`, "package:com.example.probe");
    reply(`shell settings --user ${user} list system`, "font_scale=1.0\nsystem_locales=en-US");
    reply(`shell settings --user ${user} list secure`, "enabled_input_methods=\nlocation_mode=3");
  }
  reply("shell dumpsys package 'android'", androidPackageDump("android", users));
  reply(
    "shell dumpsys package 'com.example.probe'",
    androidPackageDump("com.example.probe", users),
  );
  reply("shell settings --user 0 list global", "animator_duration_scale=0.5");
  reply("shell wm density", "Physical density: 420\nOverride density: 480");
  reply("shell wm size", "Physical size: 1080x1920");
  reply("shell cmd uimode night", "Night mode: auto");
  reply("shell getprop persist.sys.locale", "en-US");
  reply("shell getprop persist.sys.timezone", "America/Chicago");
  reply(
    "shell dumpsys account",
    users.map((user) => `User UserInfo{${user}:Owner:c13}:\n  Accounts: 0`).join("\n"),
  );
  return { adb, reply };
}
