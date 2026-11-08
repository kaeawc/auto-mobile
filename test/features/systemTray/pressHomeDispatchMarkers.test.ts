import { afterEach, describe, expect, test } from "bun:test";
import { PressButton } from "../../../src/features/action/PressButton";
import {
  getSystemTrayDependencies,
  resetSystemTrayDependencies,
  setSystemTrayDependencies,
} from "../../../src/features/systemTray/helpers/dependencies";
import type { BootedDevice } from "../../../src/models";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeIOSCtrlProxy } from "../../fakes/FakeIOSCtrlProxy";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeWindow } from "../../fakes/FakeWindow";
import { spyOnIosClientInstance } from "../../helpers/iosCtrlProxyClientSpies";
import { createObserveResultForTest } from "../observe/flatHierarchyBuilders";

// A physical iPhone: HOME goes to the runner's requestPressHome, not simctl.
const device: BootedDevice = { deviceId: "physical-iphone", platform: "ios", name: "iPhone" };

/** Drive the production pressHomeFactory over a real PressButton and a fake runner (#14387). */
async function pressHomeThroughAdapter(
  runnerResult: Parameters<FakeIOSCtrlProxy["setPressHomeResult"]>[0],
) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const proxy = new FakeIOSCtrlProxy(timer);
  proxy.setPressHomeResult(runnerResult);
  const observeScreen = new FakeObserveScreen();
  observeScreen.setObserveResult(createObserveResultForTest());
  setSystemTrayDependencies({
    pressButtonFactory: (target) =>
      new PressButton(target, null, timer, {
        observeScreen,
        awaitIdle: new FakeAwaitIdle(),
        window: new FakeWindow(),
      }),
  });
  const pressHome = getSystemTrayDependencies().pressHomeFactory;
  if (!pressHome) {
    throw new Error("production pressHomeFactory is missing");
  }
  const instance = spyOnIosClientInstance(proxy);
  try {
    return { result: await pressHome(device), proxy };
  } finally {
    instance.mockRestore();
  }
}

describe("systemTray production pressHomeFactory dispatch markers", () => {
  afterEach(() => resetSystemTrayDependencies());

  test("a dispatched HOME whose reply timed out stays dispatched and unacknowledged", async () => {
    const { result, proxy } = await pressHomeThroughAdapter({
      success: false,
      totalTimeMs: 0,
      error: "Request timed out",
      dispatched: true,
      acknowledged: false,
    });

    expect(proxy.getPressHomeRequestCount()).toBe(1);
    expect(result).toEqual({
      success: false,
      error: "Request timed out",
      dispatched: true,
      acknowledged: false,
    });
  });

  test("a runner refusal of HOME stays an acknowledged failure", async () => {
    const { result } = await pressHomeThroughAdapter({
      success: false,
      totalTimeMs: 0,
      error: "SpringBoard refused",
      dispatched: true,
      acknowledged: true,
    });

    expect(result).toEqual({
      success: false,
      error: "SpringBoard refused",
      dispatched: true,
      acknowledged: true,
    });
  });

  test("a HOME that never reached the socket stays undispatched", async () => {
    const { result } = await pressHomeThroughAdapter({
      success: false,
      totalTimeMs: 0,
      error: "Socket closed before send",
      dispatched: false,
      acknowledged: false,
    });

    expect(result.success).toBe(false);
    expect(result.dispatched).toBe(false);
  });
});
