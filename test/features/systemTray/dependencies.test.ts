import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  getSystemTrayDependencies,
  resetSystemTrayDependencies,
} from "../../../src/features/systemTray/helpers/dependencies";
import * as panelSource from "../../../src/utils/ios-cmdline-tools/DevicectlPanelScreenshotSource";
import type { BootedDevice } from "../../../src/models";

const device: BootedDevice = {
  name: "iPhone_15",
  platform: "ios",
  deviceId: "ios-device-1",
  source: "local",
};

describe("systemTray default observer dependencies", () => {
  afterEach(() => resetSystemTrayDependencies());

  test("creates the live iOS panel source for the default observer", () => {
    // Calls through: constructing the production source only wires its collaborators.
    const createSource = spyOn(panelSource, "createProductionDevicectlPanelScreenshotSource");

    getSystemTrayDependencies().observeScreenFactory(device);

    expect(createSource).toHaveBeenCalledTimes(1);
    createSource.mockRestore();
  });
});
