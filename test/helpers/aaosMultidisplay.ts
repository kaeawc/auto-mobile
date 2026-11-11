import { readFileSync } from "node:fs";
import type { BootedDevice } from "../../src/models";
import { createExecResult } from "../../src/utils/execResult";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";

const fixture = (name: string) =>
  readFileSync(
    new URL(`../fixtures/android-display/aaos-multidisplay/${name}`, import.meta.url),
    "utf8",
  );

export const aaosDumpsysDisplay = fixture("dumpsys-display.txt");
export const aaosGetDisplays = fixture("get-displays-default-only.txt");
export const aaosVirtualKey = "virtual:com.android.emulator.multidisplay:1234562";
export const aaosDevice: BootedDevice = {
  deviceId: "aaos-hidden-displays",
  name: "l17606-aaos",
  platform: "android",
  apiLevel: 34,
  displays: {
    panels: [
      { key: "4619827259835644672", role: "unknown", sizePx: { width: 1024, height: 768 } },
      { key: "4619827551948147201", role: "cluster", sizePx: { width: 400, height: 600 } },
      {
        key: "virtual:com.android.car.cluster.osdouble:ClusterDisplay",
        role: "virtual",
        sizePx: { width: 400, height: 500 },
      },
      { key: aaosVirtualKey, role: "virtual", sizePx: { width: 1280, height: 720 } },
    ],
    postures: [],
  },
};

export function aaosAdb(): FakeAdbExecutor {
  const adb = new FakeAdbExecutor();
  adb.setCommandResponse("cmd display get-displays", createExecResult(aaosGetDisplays, ""));
  adb.setCommandResponse("dumpsys display", createExecResult(aaosDumpsysDisplay, ""));
  return adb;
}
