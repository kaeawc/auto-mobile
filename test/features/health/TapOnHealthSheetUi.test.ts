import { describe, expect, test } from "bun:test";
import type { BootedDevice, ViewHierarchyNode, ViewHierarchyResult } from "../../../src/models";
import type {
  SystemAlertHierarchyReader,
  SystemAlertTapper,
  SystemAlertTapSelector,
} from "../../../src/features/action/systemAlerts/SystemAlertGate";
import {
  iosSimulatorByUdid,
  sheetElementsOf,
  TapOnHealthSheetUi,
} from "../../../src/features/health/TapOnHealthSheetUi";
import {
  ALLOW_TAP,
  planHealthSheetTaps,
  TURN_ON_ALL_TAP,
} from "../../../src/utils/ios/healthKitSeeder";

const node = (attrs: Record<string, unknown>, children?: ViewHierarchyNode[]): ViewHierarchyNode =>
  ({ $: attrs, ...(children ? { node: children } : {}) }) as ViewHierarchyNode;

// The Health Access sheet's measured identifiers (#18796), as the iOS hierarchy carries them.
const sheet: ViewHierarchyResult = {
  hierarchy: {
    node: node({ className: "UIWindow" }, [
      node({ "resource-id": "healthauthorization_icon_large" }),
      node({ "resource-id": "UIA.Health.AuthSheet.AllCategoryButton", text: "Turn On All" }),
      node({ "resource-id": "UIA.Health.Write.Steps.SwitchCell", text: "Steps" }),
      node({ text: "Health Access" }),
    ]),
  },
};

class FakeReader implements SystemAlertHierarchyReader {
  devices: BootedDevice[] = [];
  constructor(private readonly result: ViewHierarchyResult | null) {}
  async read(device: BootedDevice): Promise<ViewHierarchyResult | null> {
    this.devices.push(device);
    return this.result;
  }
}

class FakeTapper implements SystemAlertTapper {
  taps: Array<{ deviceId: string; selector: SystemAlertTapSelector }> = [];
  constructor(private readonly outcome: { success: boolean; error?: string } = { success: true }) {}
  async tap(device: BootedDevice, selector: SystemAlertTapSelector) {
    this.taps.push({ deviceId: device.deviceId, selector });
    return this.outcome;
  }
}

describe("sheetElementsOf", () => {
  test("keeps identified nodes with their labels", () => {
    expect(sheetElementsOf(sheet)).toEqual([
      { elementId: "healthauthorization_icon_large" },
      { elementId: "UIA.Health.AuthSheet.AllCategoryButton", label: "Turn On All" },
      { elementId: "UIA.Health.Write.Steps.SwitchCell", label: "Steps" },
    ]);
  });
  test("feeds the sheet plan", () => {
    expect(planHealthSheetTaps(sheetElementsOf(sheet))).toEqual([TURN_ON_ALL_TAP, ALLOW_TAP]);
  });
});

describe("TapOnHealthSheetUi", () => {
  test("reads the simulator addressed by UDID", async () => {
    const reader = new FakeReader(sheet);
    const ui = new TapOnHealthSheetUi(iosSimulatorByUdid, { reader, tapper: new FakeTapper() });
    expect(await ui.elements("SIM-1")).toHaveLength(3);
    expect(reader.devices).toEqual([{ deviceId: "SIM-1", name: "SIM-1", platform: "ios" }]);
  });

  test("a read without a hierarchy is no sheet", async () => {
    const ui = new TapOnHealthSheetUi(iosSimulatorByUdid, {
      reader: new FakeReader(null),
      tapper: new FakeTapper(),
    });
    expect(await ui.elements("SIM-1")).toEqual([]);
  });

  test("taps the planned selectors with tapOn", async () => {
    const tapper = new FakeTapper();
    const ui = new TapOnHealthSheetUi(iosSimulatorByUdid, {
      reader: new FakeReader(sheet),
      tapper,
    });
    await ui.tap("SIM-1", TURN_ON_ALL_TAP);
    await ui.tap("SIM-1", ALLOW_TAP);
    expect(tapper.taps).toEqual([
      { deviceId: "SIM-1", selector: { text: "Turn On All" } },
      { deviceId: "SIM-1", selector: { elementId: "UIA.Health.Allow.Button" } },
    ]);
  });

  test("a failed tap throws with the selector and the tapOn error", async () => {
    const ui = new TapOnHealthSheetUi(iosSimulatorByUdid, {
      reader: new FakeReader(sheet),
      tapper: new FakeTapper({ success: false, error: "element not found" }),
    });
    await expect(ui.tap("SIM-1", ALLOW_TAP)).rejects.toThrow(
      /UIA\.Health\.Allow\.Button.*element not found/,
    );
  });
});
