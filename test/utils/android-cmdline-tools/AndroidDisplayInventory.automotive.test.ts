import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseAndroidDeviceDisplays,
  readAndroidDeviceDisplaysChecked,
} from "../../../src/utils/android-cmdline-tools/AndroidDisplayInventory";
import { buildDisconnectedPanelMessage, type DisplayPanel } from "../../../src/models/DisplayPanel";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { createExecResult } from "../../../src/utils/execResult";

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dir, "../../fixtures/android-display", name), "utf8");

// The AAOS API 34 emulator display set reported in #16741: center display 1024 x 768 and the
// instrument cluster panel 528 x 792 on the same two emulator physical ids every AVD uses, plus the
// cluster app's virtual display. A recaptured device dump replaces these lines (#16741 device work).
const CENTER = "4619827259835644672";
const CLUSTER = "4619827551948147201";
const carSurfaceFlinger = fixture("fold-surfaceflinger.txt");
const carDisplayDeviceInfo = [
  "  mDisplayDevices=[",
  `    DisplayDeviceInfo{"Built-in Screen": uniqueId="local:${CENTER}", 1024 x 768, density 160, touch INTERNAL, type INTERNAL, FLAG_DEFAULT_DISPLAY}`,
  `    DisplayDeviceInfo{"Built-in Screen": uniqueId="local:${CLUSTER}", 528 x 792, density 160, touch INTERNAL, type INTERNAL}`,
  '    DisplayDeviceInfo{"ClusterOsDouble-VD": uniqueId="virtual:com.android.car.cluster.osdouble:ClusterDisplay", 528 x 692, density 160, touch NONE, type VIRTUAL}',
  "  ]",
].join("\n");
const noStates = "Supported states: [\n]\n";

const carPanels: DisplayPanel[] = [
  { key: CENTER, role: "inner", sizePx: { width: 1024, height: 768 } },
  { key: CLUSTER, role: "cluster", sizePx: { width: 528, height: 792 } },
  {
    key: "virtual:com.android.car.cluster.osdouble:ClusterDisplay",
    role: "virtual",
    sizePx: { width: 528, height: 692 },
  },
];

function carAdb(characteristics: string | Error): FakeAdbExecutor {
  const adb = new FakeAdbExecutor();
  adb.setCommandResponse(
    "dumpsys SurfaceFlinger --display-id",
    createExecResult(carSurfaceFlinger, ""),
  );
  adb.setCommandResponse("dumpsys display", createExecResult(carDisplayDeviceInfo, ""));
  adb.setCommandResponse("cmd device_state print-states", createExecResult(noStates, ""));
  if (characteristics instanceof Error) {
    adb.setCommandError("getprop ro.build.characteristics", characteristics);
  } else {
    adb.setCommandResponse(
      "getprop ro.build.characteristics",
      createExecResult(`${characteristics}\n`, ""),
    );
  }
  return adb;
}

describe("automotive display roles (#16741)", () => {
  test("an automotive display set yields a cluster panel and no postures", () => {
    expect(
      parseAndroidDeviceDisplays(carSurfaceFlinger, carDisplayDeviceInfo, noStates, {
        automotive: true,
      }),
    ).toEqual({ panels: carPanels, postures: [] });
  });

  test("the same displays on a handheld build keep the fold classification", () => {
    expect(
      parseAndroidDeviceDisplays(carSurfaceFlinger, carDisplayDeviceInfo, noStates)?.panels.map(
        (panel) => panel.role,
      ),
    ).toEqual(["inner", "cover", "virtual"]);
  });

  test("equal-size built-in panels on a car keep the first as the center display", () => {
    const sameSize = carDisplayDeviceInfo.replace("528 x 792", "1024 x 768");
    expect(
      parseAndroidDeviceDisplays(carSurfaceFlinger, sameSize, noStates, {
        automotive: true,
      })?.panels.map((panel) => panel.role),
    ).toEqual(["inner", "cluster", "virtual"]);
  });

  test("the inventory read probes the build class and classifies the cluster", async () => {
    const adb = carAdb("emulator,automotive");
    const checked = await readAndroidDeviceDisplaysChecked(adb);
    expect(checked.displays).toEqual({ panels: carPanels, postures: [] });
    expect(adb.getExecutedCommands()).toContain("shell getprop ro.build.characteristics");
  });

  test("a non-automotive build keeps the handheld classification", async () => {
    const checked = await readAndroidDeviceDisplaysChecked(carAdb("emulator"));
    expect(checked.displays?.panels.map((panel) => panel.role)).toEqual([
      "inner",
      "cover",
      "virtual",
    ]);
    expect(checked.displays?.postures).toEqual(["unknown"]);
  });

  test("an unreadable build class keeps the handheld classification", async () => {
    const checked = await readAndroidDeviceDisplaysChecked(carAdb(new Error("offline")));
    expect(checked.displays?.panels[1].role).toBe("cover");
    expect(checked.degraded).toBe(false);
  });

  test("a foldable with postures is never probed for the build class", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(
      "dumpsys SurfaceFlinger --display-id",
      createExecResult(fixture("fold-surfaceflinger.txt"), ""),
    );
    adb.setCommandResponse(
      "dumpsys display",
      createExecResult(fixture("fold-open-display-device-info.txt"), ""),
    );
    adb.setCommandResponse(
      "cmd device_state print-states",
      createExecResult(fixture("fold-states.txt"), ""),
    );
    await readAndroidDeviceDisplaysChecked(adb);
    expect(adb.getExecutedCommands()).not.toContain("shell getprop ro.build.characteristics");
  });
});

describe("disconnected cluster guidance (#16741)", () => {
  const connected = [{ key: CENTER, role: "inner" as const }];

  test("never offers a posture remedy for the cluster", () => {
    const message = buildDisconnectedPanelMessage(CLUSTER, "cluster", connected, {
      hasPostures: true,
      pinned: false,
    });
    expect(message).toBe(
      `Display "${CLUSTER}" (cluster) is not currently connected. Connected panels: ${CENTER} (inner). Target a connected panel, omit display, or use display: "active".`,
    );
    expect(message).not.toContain("setPosture");
  });

  test("keeps the foldable cover message byte-identical", () => {
    expect(
      buildDisconnectedPanelMessage(CLUSTER, "cover", connected, {
        hasPostures: true,
        pinned: false,
      }),
    ).toBe(
      `Display "${CLUSTER}" (cover) is not connected in the current posture. Connected panels: ${CENTER} (inner). Target a connected panel, omit display, or use display: "active"; to make this panel available, change the device posture with setPosture {posture: "closed"}.`,
    );
  });
});
