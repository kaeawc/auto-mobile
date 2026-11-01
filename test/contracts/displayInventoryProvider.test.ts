import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CachingDisplayInventoryProvider } from "../../src/devices/DisplayInventoryProvider";
import {
  parseAndroidDeviceDisplays,
  readAndroidDeviceDisplaysChecked,
} from "../../src/utils/android-cmdline-tools/AndroidDisplayInventory";
import { createExecResult } from "../../src/utils/execResult";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeDisplayInventoryProvider } from "../fakes/FakeDisplayInventoryProvider";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  runDisplayInventoryProviderContract,
  type InventoryScenario,
} from "./DisplayInventoryProviderContract";

// Captured `dumpsys SurfaceFlinger --display-id`, `dumpsys display` and
// `cmd device_state print-states` output. Scenarios with no captured fixture
// (iOS simctl displays, mid-read invalidation, degraded retry timing) are not
// covered here; they stay in DisplayInventoryTransition.test.ts.
const FIXTURES: Record<"single" | "multi", [string, string, string]> = {
  single: ["phone-surfaceflinger.txt", "phone-display-device-info.txt", "phone-states.txt"],
  multi: ["fold-surfaceflinger.txt", "fold-open-display-device-info.txt", "fold-states.txt"],
};

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dir, "../fixtures/android-display", name), "utf8");

function scriptedAdb(scenario: InventoryScenario): FakeAdbExecutor {
  const adb = new FakeAdbExecutor();
  const [ids, display, states] = FIXTURES[scenario === "multi" ? "multi" : "single"];
  adb.setCommandResponse("dumpsys SurfaceFlinger --display-id", createExecResult(fixture(ids), ""));
  adb.setCommandResponse("dumpsys display", createExecResult(fixture(display), ""));
  adb.setCommandResponse("cmd device_state print-states", createExecResult(fixture(states), ""));
  if (scenario === "unreadable") {
    adb.setCommandError("dumpsys display", new Error("unavailable"));
  }
  return adb;
}

runDisplayInventoryProviderContract("CachingDisplayInventoryProvider", () => {
  let scenario: InventoryScenario = "single";
  const source = {
    read: () => readAndroidDeviceDisplaysChecked(scriptedAdb(scenario)),
  };
  return {
    provider: new CachingDisplayInventoryProvider(source, source, { timer: new FakeTimer() }),
    script: (next) => {
      scenario = next;
    },
  };
});

runDisplayInventoryProviderContract("FakeDisplayInventoryProvider", () => {
  const provider = new FakeDisplayInventoryProvider();
  return {
    provider,
    script: (scenario) => {
      const [ids, display, states] = FIXTURES[scenario === "multi" ? "multi" : "single"];
      provider.displays = parseAndroidDeviceDisplays(
        fixture(ids),
        fixture(display),
        fixture(states),
      );
      provider.outcome =
        scenario === "unreadable" ? { kind: "unreadable", reason: "unavailable" } : undefined;
    },
  };
});
