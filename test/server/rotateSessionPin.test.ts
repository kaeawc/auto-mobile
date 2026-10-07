import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Rotate } from "../../src/features/action/Rotate";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import { selectedDisplayPin } from "../../src/features/observe/SessionDisplayContext";
import { rotateSchema } from "../../src/server/interactionTools";
import { runSessionDisplayPin } from "../../src/server/sessionDisplayPin";
import { createExecResult } from "../../src/utils/execResult";
import type { BootedDevice, ObserveResult } from "../../src/models";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeAwaitIdle } from "../fakes/FakeAwaitIdle";
import { FakeObserveScreen } from "../fakes/FakeObserveScreen";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeWindow } from "../fakes/FakeWindow";

// A session display pin never implicitly redirects rotate; callers opt into an explicit ID.
const windowDump = (name: string): string =>
  readFileSync(join(import.meta.dir, "..", "features", "observe", "windowDumps", name), "utf8");

const device: BootedDevice = {
  name: "Pinned foldable",
  platform: "android",
  deviceId: "rotate-pin-device",
  source: "local",
};

afterEach(() => {
  AndroidCtrlProxyClient.resetInstances();
});

describe("rotate in a session pinned to a non-default display", () => {
  test("the schema accepts only non-negative integer display IDs", () => {
    expect(rotateSchema.safeParse({ orientation: "portrait", display: 3 }).success).toBe(true);
    expect(rotateSchema.safeParse({ orientation: "portrait", display: -1 }).success).toBe(false);
    expect(rotateSchema.safeParse({ orientation: "portrait", display: 1.5 }).success).toBe(false);
  });

  test("a pinned session's rotate call is passed through unrouted and probes the default display", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("shell wm size", createExecResult("Physical size: 1080x2400", ""));
    adb.setCommandResponse(
      "shell dumpsys window displays",
      createExecResult(windowDump("dumpsys-window-displays-mirror-portrait.txt"), ""),
    );
    adb.setCommandResponse("shell settings get system user_rotation", createExecResult("0", ""));
    adb.setCommandResponse(
      "shell settings get system accelerometer_rotation",
      createExecResult("0", ""),
    );
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const observeScreen = new FakeObserveScreen();
    observeScreen.enableAutoVaryHierarchy();
    observeScreen.setObserveResult(
      () =>
        ({
          timestamp: 0,
          screenSize: { width: 1080, height: 2400 },
          systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
          viewHierarchy: { node: {} },
        }) as ObserveResult,
    );
    const window = new FakeWindow();
    window.configureCachedActiveWindow(null);
    window.configureActiveWindow({ appId: "com.test.app", activityName: "Main", layoutSeqSum: 1 });
    const rotate = new Rotate(device, adb, timer);
    rotate.awaitIdle = new FakeAwaitIdle();
    rotate.observeScreen = observeScreen;
    rotate.window = window;

    let pinSeenByHandler: string | undefined = "unset";
    let argsSeenByHandler: Record<string, unknown> = {};
    const result = await runSessionDisplayPin({
      name: "rotate",
      acceptsDisplay: Object.hasOwn(rotateSchema.shape, "display"),
      device,
      args: { orientation: "portrait" },
      sessionUuid: "pinned-session",
      store: {
        getDeviceForSession: () => device.deviceId,
        getDisplayPin: () => "cover",
      },
      invoke: async (args) => {
        pinSeenByHandler = selectedDisplayPin();
        argsSeenByHandler = args;
        return rotate.execute("portrait");
      },
    });

    expect(pinSeenByHandler).toBeUndefined();
    expect(argsSeenByHandler).toEqual({ orientation: "portrait" });
    expect(result).toMatchObject({ success: true, currentOrientation: "portrait" });
    const probes = adb.getExecutedCommands().filter((command) => command.includes("wm size"));
    expect(probes).toEqual(["shell wm size"]);
  });
});
