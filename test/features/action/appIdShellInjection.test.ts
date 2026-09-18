import { describe, expect, test } from "bun:test";
import { ClearAppData } from "../../../src/features/action/ClearAppData";
import { LaunchApp } from "../../../src/features/action/LaunchApp";
import { TerminateApp } from "../../../src/features/action/TerminateApp";
import { UninstallApp } from "../../../src/features/action/UninstallApp";
import type { BootedDevice } from "../../../src/models";
import type { AdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";

const device: BootedDevice = {
  deviceId: "emulator-5554",
  name: "Pixel",
  platform: "android",
};
const hostileAppIds: Array<[string, string, string]> = [
  ["semicolon", "com.example; input keyevent 3", "'com.example; input keyevent 3'"],
  ["command substitution", "com.example.$(id)", "'com.example.$(id)'"],
  ["backtick substitution", "com.example.`id`", "'com.example.`id`'"],
  [
    "single quote breakout",
    "com.example' ; input keyevent 3",
    "'com.example'\\'' ; input keyevent 3'",
  ],
];
const processNameCompatiblePayloads = hostileAppIds.slice(1, 3);

function adbFactoryFor(adb: FakeAdbExecutor): AdbClientFactory {
  return { create: () => adb };
}

describe("app ID device-shell boundaries", () => {
  test.each(hostileAppIds)(
    "launchApp keeps %s inside one device-shell word",
    async (_label, appId, quoted) => {
      const adb = new FakeAdbExecutor();
      const launch = new LaunchApp(device, adb as any);
      const perf = {
        track: async <T>(_name: string, action: () => Promise<T>) => action(),
        end: () => {},
      };

      await (
        launch as unknown as {
          performLaunch(
            packageName: string,
            activityName: undefined,
            userId: number,
            perf: typeof perf,
          ): Promise<unknown>;
        }
      ).performLaunch(appId, undefined, 0, perf);

      expect(adb.getExecutedCommands()).toEqual([
        `shell am start --user 0 -a android.intent.action.MAIN -c android.intent.category.LAUNCHER ${quoted}`,
        `shell monkey -p ${quoted} --user 0 1`,
      ]);
    },
  );

  test.each(hostileAppIds)(
    "clearAppData keeps %s inside one device-shell word",
    async (_label, appId, quoted) => {
      const adb = new FakeAdbExecutor();

      await new ClearAppData(device, adbFactoryFor(adb)).execute(appId, 0);

      expect(adb.getExecutedCommands()).toEqual([`shell pm clear --user 0 ${quoted}`]);
    },
  );

  test.each(processNameCompatiblePayloads)(
    "terminateApp quotes force-stop app ID for %s",
    async (_label, appId, quoted) => {
      const adb = new FakeAdbClient();
      adb.setUsers([{ userId: 0, name: "Owner", flags: 0x4000, running: true }]);
      adb.setCommandResult(`shell pm list packages --user 0 -f ${quoted} | grep -c ${quoted}`, "1");
      adb.setCommandResult(
        "shell dumpsys activity processes",
        `123:com.safe.process/u0a123\npackageList={${appId}}`,
      );
      adb.setForegroundApp({ packageName: appId, userId: 0 });

      await new TerminateApp(device, adb as any, null, new FakeTimer()).execute(appId, {
        skipObservation: true,
      });

      expect(adb.getCommandCalls().map((call) => call.command)).toContain(
        `shell am force-stop --user 0 ${quoted}`,
      );
    },
  );

  test.each(hostileAppIds)(
    "uninstallApp quotes package ID for %s",
    async (_label, appId, quoted) => {
      const adb = new FakeAdbClient();
      adb.setUsers([{ userId: 0, name: "Owner", flags: 0x4000, running: true }]);
      adb.setCommandResultSequence("shell pm list packages --user 0", [
        { stdout: `package:${appId}` },
        { stdout: "" },
      ]);

      await new UninstallApp(device, { create: () => adb } as AdbClientFactory).execute(appId);

      const commands = adb.getCommandCalls().map((call) => call.command);
      expect(commands).toContain(`shell am force-stop --user 0 ${quoted}`);
      expect(commands).toContain(`shell pm uninstall --user 0 ${quoted}`);
    },
  );
});
