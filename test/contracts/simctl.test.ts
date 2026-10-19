import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SimCtlClient } from "../../src/utils/ios-cmdline-tools/SimCtlClient";
import type {
  AppleDeviceRuntime,
  AppleDeviceType,
} from "../../src/utils/ios-cmdline-tools/SimCtlClient";
import type { ExecResult } from "../../src/models";
import { FakeSimctl } from "../fakes/FakeSimctl";
import { FakeTimer } from "../fakes/FakeTimer";
import { runSimctlContract, type ScriptedSimctl } from "./SimctlContract";

const FIXTURES = join(import.meta.dir, "../fixtures/ios-simctl");
const readFixture = <T>(file: string, key: string): T[] =>
  (JSON.parse(readFileSync(join(FIXTURES, file), "utf8")) as Record<string, T[]>)[key];

const data = {
  runtimes: readFixture<AppleDeviceRuntime>("list-runtimes.json", "runtimes"),
  deviceTypes: readFixture<AppleDeviceType>("list-devicetypes.json", "devicetypes"),
};

function execResult(stdout: string): ExecResult {
  return {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (search: string) => stdout.includes(search),
  };
}

function scriptedFake(): ScriptedSimctl {
  const fake = new FakeSimctl();
  return {
    simctl: fake,
    scriptRuntimes: (runtimes) => fake.setRuntimes(runtimes),
    scriptDeviceTypes: (types) => fake.setDeviceTypes(types),
    scriptMalformedOutput: () => fake.setMalformedListings(),
    scriptCommandFailure: (error) => {
      fake.setRuntimesError(error);
      fake.setDeviceTypesError(error);
    },
  };
}

// The real client replays `xcrun simctl list ... --json` stdout through its exec seam: no Xcode.
function scriptedReal(): ScriptedSimctl {
  const stdouts = new Map<string, string>();
  let failure: Error | null = null;
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const client = new SimCtlClient(
    null,
    async (_file, args) => {
      if (failure) {
        throw failure;
      }
      return execResult(stdouts.get(args.slice(1, 3).join(" ")) ?? "");
    },
    { timer, platform: "darwin" },
  );
  return {
    simctl: client,
    scriptRuntimes: (runtimes) => stdouts.set("list runtimes", JSON.stringify({ runtimes })),
    scriptDeviceTypes: (types) =>
      stdouts.set("list devicetypes", JSON.stringify({ devicetypes: types })),
    scriptMalformedOutput: () => {
      stdouts.set("list runtimes", "not json");
      stdouts.set("list devicetypes", "not json");
    },
    scriptCommandFailure: (error) => {
      failure = error;
    },
  };
}

runSimctlContract("FakeSimctl", scriptedFake, data);
runSimctlContract("SimCtlClient (replayed simctl output)", scriptedReal, data);
