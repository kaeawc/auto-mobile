import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ActionableError } from "../../../src/models/ActionableError";
import { createExecResult } from "../../../src/utils/execResult";
import { SimCtlClient } from "../../../src/utils/ios-cmdline-tools/SimCtlClient";
import { resetSimCtlSharedStateForTesting } from "../../../src/utils/ios-cmdline-tools/SimCtlSharedState";
import { parseCoreSimulatorCurrentState } from "../../../src/utils/ios-cmdline-tools/SimCtlSupport";
import { isIosSimulatorAlreadyStoppedError } from "../../../src/utils/ios-cmdline-tools/simulatorStateErrors";
import { FakeTimer } from "../../fakes/FakeTimer";

// The production callers of the simctl failure classifier (#14116), over the verbatim stderr
// captured on a real simulator (see test/fixtures/ios-simctl/README.md).
function captured(name: string): string {
  return readFileSync(join(import.meta.dir, "../../fixtures/ios-simctl/failures", name), "utf8");
}

const BOOT_ON_BOOTED = captured("boot-already-booted-405.stderr.txt");
const SHUTDOWN_ON_SHUTDOWN = captured("shutdown-already-shutdown-405.stderr.txt");
const ERASE_ON_BOOTED = captured("erase-booted-405.stderr.txt");
const INVALID_DEVICE = captured("boot-invalid-device.stderr.txt");
const DATA_MISSING = captured("boot-data-missing-on-disk.stderr.txt");

const UDID = "11111111-2222-3333-4444-555555555555";

/** An exec failure shaped like the simctl runner's: exit code plus captured stderr. */
function execFailure(exitCode: number, stderr: string): Error {
  return Object.assign(new Error(`Command failed with exit code ${exitCode}`), {
    code: exitCode,
    stderr,
  });
}

function withCode(text: string, code: string): string {
  return text.replace("code=405", `code=${code}`);
}

describe("parseCoreSimulatorCurrentState", () => {
  test("reads the state of the captured boot-on-Booted rejection", () => {
    expect(parseCoreSimulatorCurrentState(execFailure(149, BOOT_ON_BOOTED), UDID)).toBe("Booted");
  });

  test.each(["163", "165"])("reads the code=%s variant by its text", (code) => {
    const error = execFailure(149, withCode(BOOT_ON_BOOTED, code));
    expect(parseCoreSimulatorCurrentState(error, UDID)).toBe("Booted");
  });

  test("reads a mid-transition state whole", () => {
    const error = execFailure(149, BOOT_ON_BOOTED.replace("state: Booted", "state: Shutting Down"));
    expect(parseCoreSimulatorCurrentState(error, UDID)).toBe("Shutting Down");
  });

  test("ignores failures that are not a current-state rejection", () => {
    for (const stderr of [DATA_MISSING, INVALID_DEVICE, "unrelated failure"]) {
      expect(parseCoreSimulatorCurrentState(execFailure(2, stderr), UDID)).toBeUndefined();
    }
  });

  test("needs a structured exec failure for a simulator UDID", () => {
    expect(parseCoreSimulatorCurrentState(new Error(BOOT_ON_BOOTED), UDID)).toBeUndefined();
    expect(parseCoreSimulatorCurrentState(execFailure(0, BOOT_ON_BOOTED), UDID)).toBeUndefined();
    expect(
      parseCoreSimulatorCurrentState(execFailure(149, BOOT_ON_BOOTED), "not-a-simulator"),
    ).toBeUndefined();
  });
});

describe("isIosSimulatorAlreadyStoppedError", () => {
  test("accepts the captured shutdown-on-Shutdown stderr behind a generic message", () => {
    expect(isIosSimulatorAlreadyStoppedError(execFailure(149, SHUTDOWN_ON_SHUTDOWN))).toBe(true);
  });

  test.each(["163", "165"])("accepts the code=%s variant", (code) => {
    const error = execFailure(149, withCode(SHUTDOWN_ON_SHUTDOWN, code));
    expect(isIosSimulatorAlreadyStoppedError(error)).toBe(true);
  });

  test("keeps the older already-stopped wordings", () => {
    for (const message of [
      "The device is already shut down.",
      "already shutdown",
      "Invalid device: simulator is not booted",
      "Invalid device state",
    ]) {
      expect(isIosSimulatorAlreadyStoppedError(new Error(message))).toBe(true);
    }
  });

  test("does not accept another state or another failure", () => {
    for (const stderr of [
      SHUTDOWN_ON_SHUTDOWN.replace("state: Shutdown", "state: Shutting Down"),
      ERASE_ON_BOOTED,
      DATA_MISSING,
    ]) {
      expect(isIosSimulatorAlreadyStoppedError(execFailure(149, stderr))).toBe(false);
    }
  });
});

describe("SimCtlClient.eraseSimulator", () => {
  beforeEach(() => {
    resetSimCtlSharedStateForTesting();
  });

  function clientFailingEraseWith(error: Error): { client: SimCtlClient; calls: string[] } {
    const calls: string[] = [];
    const client = new SimCtlClient(
      null,
      async (file, args) => {
        const command = `${file} ${args.join(" ")}`;
        calls.push(command);
        if (args[1] === "erase") {
          throw error;
        }
        return createExecResult("", "");
      },
      { timer: new FakeTimer(), platform: "darwin" },
    );
    return { client, calls };
  }

  test("erase on a Booted simulator tells the caller to shut it down first", async () => {
    const failure = execFailure(149, ERASE_ON_BOOTED);
    const { client, calls } = clientFailingEraseWith(failure);

    const error = await client.eraseSimulator(UDID).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ActionableError);
    const actionable = error as ActionableError;
    expect(actionable.message).toContain(`Simulator ${UDID} cannot be erased while it is Booted`);
    expect(actionable.message).toContain(`xcrun simctl shutdown ${UDID}`);
    expect(actionable.cause).toBe(failure);
    expect(calls.filter((call) => call.includes(" erase "))).toHaveLength(1);
  });

  test("the code=163 variant is the same state conflict", async () => {
    const { client } = clientFailingEraseWith(execFailure(149, withCode(ERASE_ON_BOOTED, "163")));

    await expect(client.eraseSimulator(UDID)).rejects.toThrow(
      "cannot be erased while it is Booted",
    );
  });

  test("any other erase failure is rethrown unchanged", async () => {
    const failure = execFailure(148, INVALID_DEVICE);
    const { client } = clientFailingEraseWith(failure);

    await expect(client.eraseSimulator(UDID)).rejects.toBe(failure);
  });
});
