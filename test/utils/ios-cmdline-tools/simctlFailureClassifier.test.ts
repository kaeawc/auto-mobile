import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ActionableError } from "../../../src/models/ActionableError";
import {
  bootFailureGuidanceError,
  classifySimctlError,
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

// Not captured on a host (#14116): inducing these is host-wide or impossible. The resource
// exhaustion line is the text cited from Apple Developer Forums thread 675824; the launchd_sim
// line carries the stable "could not bind to session" phrase the issue classifies by.
const RESOURCE_EXHAUSTION =
  "The current system settings are not sufficient to allow booting additional simulators: maxFiles";
const LAUNCHD_SIM_BIND = "launchd_sim could not bind to session";

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

  test("host resource exhaustion is classified by text", () => {
    expect(classifySimctlFailure("boot", RESOURCE_EXHAUSTION)).toEqual({
      kind: "resource-exhaustion",
    });
  });

  test("a launchd_sim bind failure is detected by text", () => {
    expect(classifySimctlFailure("boot", `Failed to boot: ${LAUNCHD_SIM_BIND}`)).toEqual({
      kind: "launchd-sim-bind-failure",
    });
  });

  test("other text is unclassified", () => {
    expect(classifySimctlFailure("boot", "Command failed").kind).toBe("unclassified");
  });
});

describe("classifySimctlFailure across Xcode versions", () => {
  // #14116: the "current state" error has carried code 405, 163 and 165; only the text decides.
  test.each(["163", "165"])("the code=%s variant of boot on Booted is the same success", (code) => {
    const text = BOOT_ON_BOOTED.replace("code=405", `code=${code}`);
    expect(text).toContain(`code=${code}`);
    expect(classifySimctlFailure("boot", text)).toEqual({
      kind: "already-in-target-state",
      verb: "boot",
      state: "Booted",
    });
  });

  test("a two-word state is captured whole", () => {
    const text = BOOT_ON_BOOTED.replace("state: Booted", "state: Shutting Down");
    expect(classifySimctlFailure("boot", text)).toEqual({
      kind: "state-conflict",
      verb: "boot",
      state: "Shutting Down",
    });
  });

  test("a domain clause appended after the state is not part of the state", () => {
    const text =
      "Unable to boot device in current state: Booted " +
      "(domain=com.apple.CoreSimulator.SimError, code=405)";
    expect(classifySimctlFailure("boot", text)).toMatchObject({ state: "Booted" });
  });
});

describe("classifySimctlError", () => {
  test("reads the simctl failure a wrapping error carries as its cause", () => {
    const failure = execFailure(148, INVALID_DEVICE);
    const wrapped = new ActionableError(`Simulator with UDID ${UDID} not found`, {
      cause: new ActionableError("boot failed", { cause: failure }),
    });
    expect(classifySimctlError("boot", wrapped)).toEqual({ kind: "unknown-device" });
  });

  test("an error with no recognizable text in its chain is unclassified", () => {
    const looped: Error & { cause?: unknown } = new Error("boot failed");
    looped.cause = looped;
    expect(classifySimctlError("boot", looped)).toEqual({ kind: "unclassified" });
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

  test("a state conflict, unknown device or host-level failure never recovers", () => {
    for (const failure of [
      classifySimctlFailure("erase", ERASE_ON_BOOTED),
      classifySimctlFailure("boot", INVALID_DEVICE),
      classifySimctlFailure("boot", RESOURCE_EXHAUSTION),
      classifySimctlFailure("boot", LAUNCHD_SIM_BIND),
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

describe("bootFailureGuidanceError", () => {
  test("names the erase recovery for missing on-disk data and keeps the cause", () => {
    const failure = execFailure(2, DATA_MISSING);
    const error = bootFailureGuidanceError(UDID, failure);
    expect(error).toBeInstanceOf(ActionableError);
    expect(error?.message).toContain(`xcrun simctl erase ${UDID}`);
    expect(error?.message).toContain("data is missing on disk");
    expect(error?.cause).toBe(failure);
  });

  test("names the host-wide service relaunch for resource exhaustion, without erase", () => {
    const failure = execFailure(1, RESOURCE_EXHAUSTION);
    const error = bootFailureGuidanceError(UDID, failure);
    expect(error?.message).toContain("launchctl limit maxfiles");
    expect(error?.message).toContain("killall -9 com.apple.CoreSimulator.CoreSimulatorService");
    expect(error?.message).toContain("every simulator on the host");
    expect(error?.message).not.toContain("simctl erase");
    expect(error?.cause).toBe(failure);
  });

  test("reports a launchd_sim bind failure as a runtime timeout, without erase", () => {
    const failure = new Error(LAUNCHD_SIM_BIND);
    const error = bootFailureGuidanceError(UDID, failure);
    expect(error?.message).toContain("launchd_sim could not bind to its session");
    expect(error?.message).toContain(`xcrun simctl shutdown ${UDID}`);
    expect(error?.message).not.toContain("simctl erase");
    expect(error?.cause).toBe(failure);
  });

  test("leaves every other boot failure to the caller", () => {
    for (const stderr of [BOOT_ON_BOOTED, INVALID_DEVICE, "something else"]) {
      expect(bootFailureGuidanceError(UDID, execFailure(149, stderr))).toBeUndefined();
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

  test("resource exhaustion fails without recovery even with the destructive opt-in", async () => {
    const port = new FakeSimctlRecoveryPort([execFailure(1, RESOURCE_EXHAUSTION)]);
    const run = runSimctlWithRecovery(port, "boot", UDID, { allowDestructive: true });
    await expect(run).rejects.toThrow(/never done automatically/);
    expect(port.calls).toEqual([`boot ${UDID}`]);
  });

  test("an unknown device (exit 148) fails without recovery", async () => {
    const port = new FakeSimctlRecoveryPort([execFailure(148, INVALID_DEVICE)]);
    const run = runSimctlWithRecovery(port, "boot", UDID, { allowDestructive: true });
    await expect(run).rejects.toThrow(/does not know this simulator/);
    expect(port.calls).toEqual([`boot ${UDID}`]);
  });
});
