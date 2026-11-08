import { createExecResult } from "../../src/utils/execResult";
import { readFileSync } from "node:fs";
import type { SimCtlClient } from "../../src/utils/ios-cmdline-tools/SimCtlClient";
import {
  parseSimulatorPairs,
  SimulatorPairService,
} from "../../src/utils/ios-cmdline-tools/SimulatorPairs";

export const pairsFixture = (name: string) =>
  readFileSync(new URL(`../fixtures/simctl/pairs/${name}`, import.meta.url), "utf8");
export const capturedPair = parseSimulatorPairs(pairsFixture("list-pairs-new.json"))[0]!;
export class FakeSimulatorPairs implements Pick<SimCtlClient, "executeCommandArgs"> {
  calls: string[][] = [];
  listing = pairsFixture("list-pairs-unpaired.json");
  pairError?: string;
  activateError?: string;
  unpairError?: string;
  async executeCommandArgs(args: string[]) {
    this.calls.push(args);
    if (args[0] === "pair") {
      if (this.pairError) {
        this.listing = pairsFixture("list-pairs-new.json");
        throw new Error(this.pairError);
      }
      this.listing = pairsFixture("list-pairs-new.json");
      return createExecResult(capturedPair.pairId, "");
    }
    if (args[0] === "pair_activate" && this.activateError) {
      throw new Error(this.activateError);
    }
    if (args[0] === "unpair" && this.unpairError) {
      throw new Error(this.unpairError);
    }
    return createExecResult(
      args[1] === "devices"
        ? JSON.stringify({
            devices: {
              "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [
                { udid: capturedPair.phone.deviceId },
              ],
              "com.apple.CoreSimulator.SimRuntime.watchOS-26-5": [
                { udid: capturedPair.watch.deviceId },
              ],
            },
          })
        : this.listing,
      "",
    );
  }
  service() {
    return new SimulatorPairService(this, new Map());
  }
}
