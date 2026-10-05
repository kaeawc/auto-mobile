import { describe, expect, test, spyOn } from "bun:test";
import { RestoreSnapshot } from "../../../src/features/action/RestoreSnapshot";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android/AndroidCtrlProxyClient";
import type { BootedDevice, DeviceSnapshotManifest } from "../../../src/models";
import type { AdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";
import { DeviceSnapshotStore } from "../../../src/utils/DeviceSnapshotStore";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeTimer } from "../../fakes/FakeTimer";

describe("RestoreSnapshot settings command ordering", () => {
  for (const mode of ["success", "failure", "throw"] as const) {
    test(`preserves settings then foreground order when accessibility puts ${mode}`, async () => {
      const device: BootedDevice = {
        deviceId: "emulator-settings-order",
        name: "Settings order fake",
        platform: "android",
      };
      const adb = new FakeAdbClient();
      const timer = new FakeTimer();
      const events: string[] = [];
      const executeCommand = adb.executeCommand.bind(adb);
      const commandSpy = spyOn(adb, "executeCommand").mockImplementation(async (command) => {
        events.push(command);
        return executeCommand(command);
      });
      const client: Pick<AndroidCtrlProxyClient, "requestSettingsPut"> = {
        requestSettingsPut: async (namespace, key, value, valueType) => {
          events.push(`a11y ${namespace}/${key} ${value} ${valueType}`);
          if (mode === "throw") {
            throw new Error("accessibility unavailable");
          }
          return { success: mode === "success", totalTimeMs: 0 };
        },
      };
      const clientSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(
        client as AndroidCtrlProxyClient,
      );
      const factory: AdbClientFactory = {
        create: () => adb as ReturnType<AdbClientFactory["create"]>,
      };
      const restore = new RestoreSnapshot(
        device,
        factory,
        undefined,
        timer,
        new DeviceSnapshotStore("/unused-snapshot-store"),
      );
      const manifest: DeviceSnapshotManifest = {
        snapshotName: "settings-order",
        timestamp: "2026-01-01T00:00:00.000Z",
        deviceId: device.deviceId,
        deviceName: device.name,
        platform: "android",
        snapshotType: "adb",
        includeAppData: true,
        includeSettings: true,
        foregroundApp: "com.example.app",
        settings: {
          global: { airplane_mode_on: "1", "invalid key": "ignored", wifi_on: "0" },
          secure: { android_id: "rejected" },
          system: { screen_brightness: "200" },
        },
      };
      adb.setCommandError(
        "shell settings put secure 'android_id' 'rejected'",
        new Error("device rejected setting"),
      );

      try {
        const result = await restore.execute({ snapshotName: manifest.snapshotName, manifest });
        const expected = [
          ["global", "airplane_mode_on", "1"],
          ["global", "wifi_on", "0"],
          ["secure", "android_id", "rejected"],
          ["system", "screen_brightness", "200"],
        ].flatMap(([namespace, key, value]) => [
          `a11y ${namespace}/${key} ${value} string`,
          ...(mode === "success" ? [] : [`shell settings put ${namespace} '${key}' '${value}'`]),
        ]);
        const foregroundCommand =
          "shell am start -a android.intent.action.MAIN -c android.intent.category.LAUNCHER 'com.example.app'";
        expect(events).toEqual([...expected, foregroundCommand]);
        expect(adb.getCommandCalls().map((call) => call.command)).toEqual([
          ...expected.filter((event) => event.startsWith("shell ")),
          foregroundCommand,
        ]);
        expect(result.failures).toEqual([
          {
            kind: "android_setting",
            namespace: "global",
            key: "invalid key",
            reason: "invalid settings key",
          },
          ...(mode === "success"
            ? []
            : [
                {
                  kind: "android_setting",
                  namespace: "secure",
                  key: "android_id",
                  reason: "device rejected setting",
                },
              ]),
        ]);
        expect(result.success).toBe(false);
      } finally {
        commandSpy.mockRestore();
        clientSpy.mockRestore();
        timer.reset();
      }
    });
  }
});
