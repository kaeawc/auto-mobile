import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { CaptureSnapshot } from "../../../src/features/action/CaptureSnapshot";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import type { SettingsNamespace } from "../../../src/features/observe/android";
import type { AdbClient } from "../../../src/utils/android-cmdline-tools/AdbClient";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";

const restores: Array<() => void> = [];
afterEach(() =>
  restores
    .splice(0)
    .reverse()
    .forEach((restore) => restore()),
);

describe("CaptureSnapshot settings characterization", () => {
  test.each(["entries", "empty", "missing", "failure", "throw", "adb-failure"] as const)(
    "preserves namespace order and exact settings for %s",
    async (mode) => {
      const adb = new FakeAdbExecutor();
      adb.setDefaultResponse({ stdout: "key=value=tail\n blank= \ninvalid\n", stderr: "" });
      if (mode === "adb-failure") {
        adb.setCommandError("secure", new Error("secure unavailable"));
      }
      const events: string[] = [];
      const originalExecute = adb.executeCommand.bind(adb);
      const execute = spyOn(adb, "executeCommand");
      execute.mockImplementation(async (command) => {
        events.push(command);
        return originalExecute(command);
      });
      const client = {
        requestSettingsList: async (namespace: SettingsNamespace) => {
          events.push(`a11y ${namespace}`);
          if (mode === "throw") {
            throw new Error("optional service unavailable");
          }
          if (mode === "entries") {
            return { success: true, entries: { namespace } };
          }
          if (mode === "empty") {
            return { success: true, entries: {} };
          }
          return { success: mode === "missing" };
        },
      };
      const instance = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(
        client as unknown as AndroidCtrlProxyClient,
      );
      restores.push(
        () => execute.mockRestore(),
        () => instance.mockRestore(),
      );
      const capture = new CaptureSnapshot(
        { deviceId: "settings-fake", name: "Fake", platform: "android" },
        { create: () => adb as unknown as AdbClient },
        undefined,
        new FakeTimer(),
      );
      const result = await capture["captureSettings"]();
      const fallback = { key: "value=tail", blank: "" };
      expect(result).toEqual(
        mode === "entries"
          ? {
              global: { namespace: "global" },
              secure: { namespace: "secure" },
              system: { namespace: "system" },
            }
          : mode === "empty"
            ? { global: {}, secure: {}, system: {} }
            : {
                global: fallback,
                secure: mode === "adb-failure" ? {} : fallback,
                system: fallback,
              },
      );
      const useAdb = mode !== "entries" && mode !== "empty";
      expect(events).toEqual(
        ["global", "secure", "system"].flatMap((namespace) =>
          useAdb
            ? [`a11y ${namespace}`, `shell settings list ${namespace}`]
            : [`a11y ${namespace}`],
        ),
      );
      expect(adb.getExecutedCommands()).toEqual(
        useAdb
          ? [
              "shell settings list global",
              "shell settings list secure",
              "shell settings list system",
            ]
          : [],
      );
    },
  );
});
