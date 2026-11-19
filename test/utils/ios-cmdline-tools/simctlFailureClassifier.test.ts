import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ActionableError } from "../../../src/models/ActionableError";
import {
  bootDataMissingError,
  classifySimctlFailure,
  planSimctlRecovery,
  runSimctlWithRecovery,
  simctlFailureText,
  type SimctlLifecycleVerb,
  type SimctlRecoveryPort,
} from "../../../src/utils/ios-cmdline-tools/simctlFailureClassifier";

// Verbatim stderr captured on a real simulator for #14116 (see the fixtures README).
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

class FakeSimctlRecoveryPort implements SimctlRecoveryPort {
  readonly calls: string[] = [];
  constructor(private readonly runFailures: Array<Error | undefined>) {}

  async run(verb: SimctlLifecycleVerb, udid: string): Promise<void> {
    this.calls.push(`${verb} ${udid}`);
    const failure = this.runFailures.shift();
    if (failure) {
      throw failure;
    }
  }

  async erase(udid: string): Promise<void> {
    this.calls.push(`erase ${udid}`);
  }
}

describe("classifySimctlFailure (captured Xcode 26.6 text)", () => {
  test("boot on a Booted device is already in the target state", () => {
    expect(classifySimctlFailure("boot", BOOT_ON_BOOTED)).toEqual({
      kind: "already-in-target-state",
      verb: "boot",
      state: "Booted",
    });
  });

  test("shutdown on a Shutdown device is already in the target state", () => {
    expect(classifySimctlFailure("shutdown", SHUTDOWN_ON_SHUTDOWN)).toEqual({
      kind: "already-in-target-state",
      verb: "shutdown",
      state: "Shutdown",
    });
  });

  test("erase on a Booted device is a state conflict, not success", () => {
    expect(classifySimctlFailure("erase", ERASE_ON_BOOTED)).toEqual({
      kind: "state-conflict",
      verb: "erase",
      state: "Booted",
    });
  });

  test("the same 405 text under a different verb is a conflict", () => {
    expect(classifySimctlFailure("shutdown", BOOT_ON_BOOTED).kind).toBe("state-conflict");
  });

  test("missing on-disk data is classified by text, not the 405 code", () => {
    expect(classifySimctlFailure("boot", DATA_MISSING)).toEqual({ kind: "device-data-missing" });
  });

  test("an unknown device is separate from a state conflict", () => {
    expect(classifySimctlFailure("boot", INVALID_DEVICE)).toEqual({ kind: "unknown-device" });
  });

  test("other text is unclassified", () => {
    expect(classifySimctlFailure("boot", "Command failed").kind).toBe("unclassified");
  });
});

describe("planSimctlRecovery", () => {
  const optIn = { allowDestructive: true };
  const optOut = { allowDestructive: false };

  test("already-in-target-state maps to success with or without the opt-in", () => {
    const failure = classifySimctlFailure("boot", BOOT_ON_BOOTED);
    expect(planSimctlRecovery(failure, optOut)).toEqual({
      action: "treat-as-success",
      state: "Booted",
    });
    expect(planSimctlRecovery(failure, optIn).action).toBe("treat-as-success");
  });

  test("missing data maps to erase only when destructive recovery is opted in", () => {
    const failure = classifySimctlFailure("boot", DATA_MISSING);
    expect(planSimctlRecovery(failure, optIn)).toEqual({ action: "erase-and-retry" });
    const refused = planSimctlRecovery(failure, optOut);
    expect(refused.action).toBe("fail");
  });

  test("a state conflict and an unknown device never erase", () => {
    for (const failure of [
      classifySimctlFailure("erase", ERASE_ON_BOOTED),
      classifySimctlFailure("boot", INVALID_DEVICE),
    ]) {
      expect(planSimctlRecovery(failure, optIn).action).toBe("fail");
    }
  });
});

describe("simctlFailureText", () => {
  test("reads a Buffer stderr ahead of the message", () => {
    const error = Object.assign(new Error("exit 149"), { stderr: Buffer.from(BOOT_ON_BOOTED) });
    expect(simctlFailureText(error)).toBe(`${BOOT_ON_BOOTED}\nexit 149`);
  });

  test("falls back to the message when there is no stderr", () => {
    expect(simctlFailureText(new Error(SHUTDOWN_ON_SHUTDOWN))).toBe(SHUTDOWN_ON_SHUTDOWN);
  });
});

describe("bootDataMissingError", () => {
  test("names the erase recovery for missing on-disk data and keeps the cause", () => {
    const failure = execFailure(2, DATA_MISSING);
    const error = bootDataMissingError(UDID, failure);
    expect(error).toBeInstanceOf(ActionableError);
    expect(error?.message).toContain(`xcrun simctl erase ${UDID}`);
    expect(error?.message).toContain("data is missing on disk");
    expect(error?.cause).toBe(failure);
  });

  test("leaves every other boot failure to the caller", () => {
    for (const stderr of [BOOT_ON_BOOTED, INVALID_DEVICE, "something else"]) {
      expect(bootDataMissingError(UDID, execFailure(149, stderr))).toBeUndefined();
    }
  });
});

describe("runSimctlWithRecovery", () => {
  test("a clean run is ok", async () => {
    const port = new FakeSimctlRecoveryPort([]);
    const outcome = await runSimctlWithRecovery(port, "boot", UDID, { allowDestructive: false });
    expect(outcome).toEqual({ status: "ok" });
    expect(port.calls).toEqual([`boot ${UDID}`]);
  });

  test("boot on Booted (exit 149) resolves as already booted", async () => {
    const port = new FakeSimctlRecoveryPort([execFailure(149, BOOT_ON_BOOTED)]);
    const outcome = await runSimctlWithRecovery(port, "boot", UDID, { allowDestructive: false });
    expect(outcome).toEqual({ status: "already-in-target-state", state: "Booted" });
    expect(port.calls).toEqual([`boot ${UDID}`]);
  });

  test("shutdown on Shutdown (exit 149) resolves as already shut down", async () => {
    const port = new FakeSimctlRecoveryPort([execFailure(149, SHUTDOWN_ON_SHUTDOWN)]);
    const outcome = await runSimctlWithRecovery(port, "shutdown", UDID, {
      allowDestructive: false,
    });
    expect(outcome).toEqual({ status: "already-in-target-state", state: "Shutdown" });
  });

  test("missing data (exit 2) is erased and booted again when opted in", async () => {
    const port = new FakeSimctlRecoveryPort([execFailure(2, DATA_MISSING), undefined]);
    const outcome = await runSimctlWithRecovery(port, "boot", UDID, { allowDestructive: true });
    expect(outcome).toEqual({ status: "recovered-by-erase" });
    expect(port.calls).toEqual([`boot ${UDID}`, `erase ${UDID}`, `boot ${UDID}`]);
  });

  test("missing data without the opt-in fails and never erases", async () => {
    const port = new FakeSimctlRecoveryPort([execFailure(2, DATA_MISSING)]);
    const run = runSimctlWithRecovery(port, "boot", UDID, { allowDestructive: false });
    await expect(run).rejects.toThrow(/destructive recovery was not enabled/);
    expect(port.calls).toEqual([`boot ${UDID}`]);
  });

  test("a retry that fails after erase surfaces an actionable error", async () => {
    const port = new FakeSimctlRecoveryPort([
      execFailure(2, DATA_MISSING),
      execFailure(2, DATA_MISSING),
    ]);
    const run = runSimctlWithRecovery(port, "boot", UDID, { allowDestructive: true });
    await expect(run).rejects.toBeInstanceOf(ActionableError);
    expect(port.calls).toEqual([`boot ${UDID}`, `erase ${UDID}`, `boot ${UDID}`]);
  });

  test("an unknown device (exit 148) fails without recovery", async () => {
    const port = new FakeSimctlRecoveryPort([execFailure(148, INVALID_DEVICE)]);
    const run = runSimctlWithRecovery(port, "boot", UDID, { allowDestructive: true });
    await expect(run).rejects.toThrow(/does not know this simulator/);
    expect(port.calls).toEqual([`boot ${UDID}`]);
  });
});
