import { afterEach, expect, test } from "bun:test";
import {
  getDeviceToolsDependencies,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../../src/features/deviceLifecycle/core/dependencies";
import type { HeadUnitInventoryEntry } from "../../../src/features/androidAuto/HeadUnitInventory";

afterEach(() => {
  resetDeviceToolsDependencies();
});

test("setDeviceToolsDependencies keeps an injected headUnitInventory reader", async () => {
  const entry: HeadUnitInventoryEntry = {
    display: "headUnit",
    role: "projected",
    projectedBy: "androidAuto",
    console: "dhu-1",
  };
  const reads: string[] = [];
  const headUnitInventory = async (deviceId: string) => {
    reads.push(deviceId);
    return entry;
  };
  setDeviceToolsDependencies({ headUnitInventory });
  expect(getDeviceToolsDependencies().headUnitInventory).toBe(headUnitInventory);
  // A later unrelated override keeps the reader rather than dropping it.
  setDeviceToolsDependencies({});
  expect(await getDeviceToolsDependencies().headUnitInventory?.("emulator-5554")).toEqual(entry);
  expect(reads).toEqual(["emulator-5554"]);
});
