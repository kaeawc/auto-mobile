import { afterEach, expect, test } from "bun:test";
import { RealObserveScreen } from "../../../src/features/observe/ObserveScreen";
import { resetObserveCacheStore } from "../../../src/features/observe/cache/ObserveCacheRegistry";
import type { BootedDevice } from "../../../src/models/DeviceInfo";
import { createExecResult } from "../../../src/utils/execResult";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeObserveCacheStore } from "../../fakes/FakeObserveCacheStore";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeViewHierarchy } from "../../fakes/FakeViewHierarchy";
import { noopObserveAudits } from "../../fakes/noopObserveAudits";

afterEach(() => {
  RealObserveScreen.clearCache();
  resetObserveCacheStore();
});

// An API 24 device: no display inventory and a hierarchy without screen dimensions (#18982).
async function observeApi24(rotation?: number) {
  const device: BootedDevice = {
    deviceId: "api24-observe-wiring",
    name: "fake",
    platform: "android",
  };
  const adb = new FakeAdbExecutor();
  adb.setCommandResponse("shell wm size", createExecResult("Physical size: 720x1280\n", ""));
  const viewHierarchy = new FakeViewHierarchy();
  viewHierarchy.configureHierarchy({
    updatedAt: 123,
    ...(rotation === undefined ? {} : { rotation }),
    hierarchy: { node: { text: "Ready", bounds: { left: 0, top: 0, right: 10, bottom: 10 } } },
  });
  const screen = new RealObserveScreen(device, new FakeAdbClientFactory(adb), {
    viewHierarchy,
    cacheStore: new FakeObserveCacheStore(new FakeTimer()),
    ...noopObserveAudits(),
  });
  return screen.execute({ skipScreenshot: true, skipBackStack: true });
}

test("observe sizes an API 24 default display from wm size", async () => {
  const result = await observeApi24();
  expect(result.screenSize).toMatchObject({ width: 720, height: 1280 });
});

test("observe rotates the wm size by the hierarchy's rotation", async () => {
  const result = await observeApi24(1);
  expect(result.screenSize).toMatchObject({ width: 1280, height: 720 });
});
