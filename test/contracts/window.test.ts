import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Window } from "../../src/features/observe/Window";
import type { ExecResult } from "../../src/models";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeWindow } from "../fakes/FakeWindow";
import { runWindowContract, type WindowContractExpectations } from "./WindowContract";

const dumpDir = join(import.meta.dir, "../features/observe/windowDumps");
const dumps = {
  primary: readFileSync(join(dumpDir, "active-window-with-popup.log"), "utf8"),
  secondary: readFileSync(join(dumpDir, "api31-settings-window-dump.log"), "utf8"),
};
const expected: WindowContractExpectations = {
  primary: {
    appId: "dev.jasonpearson.automobile.playground",
    activityName: "dev.jasonpearson.android.appshell.MainTabActivity",
  },
  secondary: { appId: "com.android.settings", activityName: "com.android.settings.Settings" },
};

const exec = (stdout: string): ExecResult => ({
  stdout,
  stderr: "",
  toString: () => stdout,
  trim: () => stdout.trim(),
  includes: (text) => stdout.includes(text),
});

runWindowContract(
  "Window (captured dumpsys)",
  () => {
    const adb = new FakeAdbExecutor();
    const window = new Window(
      { deviceId: "window-contract", name: "Test", platform: "android" },
      new FakeAdbClientFactory(adb),
      new FakeTimer(),
      // NODE_ENV=test without a data dir keeps the disk cache off.
      { NODE_ENV: "test" },
    );
    return { window, show: (which) => adb.setDefaultResponse(exec(dumps[which])) };
  },
  expected,
);

runWindowContract(
  "FakeWindow",
  () => {
    const window = new FakeWindow();
    return {
      window,
      show: (which) =>
        window.configureActiveWindow({
          ...expected[which],
          layoutSeqSum: which === "primary" ? 1 : 2,
        }),
    };
  },
  expected,
);
