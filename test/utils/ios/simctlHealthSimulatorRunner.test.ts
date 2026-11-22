import { describe, expect, test } from "bun:test";
import { ActionableError } from "../../../src/models/ActionableError";
import type { ExecFileAsync } from "../../../src/utils/HostCommandExecutor";
import { SimctlHealthSimulatorRunner } from "../../../src/utils/ios/simctlHealthSimulatorRunner";
import { FakeTimer } from "../../fakes/FakeTimer";

function runnerFailingWith(message: string): SimctlHealthSimulatorRunner {
  const exec: ExecFileAsync = async () => {
    throw new Error(message);
  };
  return new SimctlHealthSimulatorRunner(exec, new FakeTimer(), "/unused");
}

describe("SimctlHealthSimulatorRunner.terminate", () => {
  test("treats an app that is not running as already terminated", async () => {
    const runner = runnerFailingWith(
      "An error was encountered processing the command (domain=FBSOpenApplicationServiceErrorDomain, code=1): found nothing to terminate",
    );
    await expect(runner.terminate("UDID", "dev.am.hkseeder")).resolves.toBeUndefined();
  });

  test("throws an actionable error for any other terminate failure", async () => {
    const runner = runnerFailingWith("Unable to lookup in current state: Shutdown");
    const error = await runner.terminate("UDID", "dev.am.hkseeder").catch((e) => e);
    expect(error).toBeInstanceOf(ActionableError);
    expect(error.message).toContain("Failed to terminate dev.am.hkseeder");
    expect(error.message).toContain("Shutdown");
  });
});
