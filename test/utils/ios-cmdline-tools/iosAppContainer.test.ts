import { describe, expect, test } from "bun:test";
import {
  IOS_APP_DATA_FOLDERS,
  getAppDataContainerPath,
  terminateAppIfRunning,
} from "../../../src/utils/ios-cmdline-tools/iosAppContainer";
import { createExecResult } from "../../../src/utils/execResult";
import type { ExecResult } from "../../../src/models";

const deviceId = "7B3A3792-DB53-4654-BA94-27A1D305C3B7";
const bundleId = "dev.jasonpearson.automobile.ctrlproxy";

// iosAppContainer.ts holds two of the slice's only unasserted log-and-continue
// catches. Both must degrade to a non-fatal result (resolve / null) rather than
// propagate, but a real regression that let the error escape would go unnoticed
// without these.
describe("terminateAppIfRunning", () => {
  test("terminates the app on the target device", async () => {
    const calls: Array<{ bundleId: string; deviceId?: string }> = [];
    const simctl = {
      terminateApp: async (id: string, device?: string) => {
        calls.push({ bundleId: id, deviceId: device });
      },
    };

    await terminateAppIfRunning(simctl, deviceId, bundleId);

    expect(calls).toEqual([{ bundleId, deviceId }]);
  });

  test("swallows a terminate failure instead of propagating (app not running is expected)", async () => {
    const simctl = {
      terminateApp: async () => {
        throw new Error("Unable to terminate: found nothing to terminate");
      },
    };

    // Observable contract: resolves (does NOT reject) even though the underlying
    // terminate failed. `await` would throw here if the catch were removed.
    await expect(terminateAppIfRunning(simctl, deviceId, bundleId)).resolves.toBeUndefined();
  });
});

describe("getAppDataContainerPath", () => {
  const containerClient = (result: ExecResult | Error) => {
    const calls: string[][] = [];
    const simctl = {
      executeCommandArgs: async (args: string[]): Promise<ExecResult> => {
        calls.push(args);
        if (result instanceof Error) {
          throw result;
        }
        return result;
      },
    };
    return { simctl, calls };
  };

  test("returns the trimmed container path and issues the exact argv", async () => {
    const { simctl, calls } = containerClient(
      createExecResult("/Users/test/data/Containers/Data/Application/ABC\n", ""),
    );

    const result = await getAppDataContainerPath(simctl, deviceId, bundleId);

    expect(result).toBe("/Users/test/data/Containers/Data/Application/ABC");
    expect(calls).toEqual([["get_app_container", deviceId, bundleId, "data"]]);
  });

  const nullRows: ReadonlyArray<{ label: string; result: ExecResult | Error }> = [
    { label: "empty stdout", result: createExecResult("", "") },
    { label: "whitespace-only stdout", result: createExecResult("   \n", "") },
    {
      label: "the command throws (app not installed)",
      result: new Error("No such file or directory"),
    },
  ];

  for (const { label, result } of nullRows) {
    test(`returns null when ${label}`, async () => {
      const { simctl } = containerClient(result);
      expect(await getAppDataContainerPath(simctl, deviceId, bundleId)).toBeNull();
    });
  }
});

describe("IOS_APP_DATA_FOLDERS", () => {
  test("wipes the standard iOS data-container top-level folders", () => {
    expect(IOS_APP_DATA_FOLDERS).toEqual(["Documents", "Library", "tmp"]);
  });
});
