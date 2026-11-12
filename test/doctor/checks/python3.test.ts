import { describe, expect, test } from "bun:test";
import { checkPython3 } from "../../../src/doctor/checks/python3";
import { createExecResult } from "../../../src/utils/execResult";
import { FakeHostCommandExecutor } from "../../fakes/FakeHostCommandExecutor";
import { FakeLogger } from "../../fakes/FakeLogger";

describe("doctor Python requirement", () => {
  test("reports the installed version using the injected runner and probe signal", async () => {
    const commands = new FakeHostCommandExecutor();
    const log = new FakeLogger();
    const controller = new AbortController();
    commands.setDefaultResponse(createExecResult("Python 3.11.9\n", ""));
    expect(
      await checkPython3({ timeoutMs: 100, signal: controller.signal }, { commands, log }),
    ).toMatchObject({ status: "pass", message: "Python 3.11.9" });
    expect(commands.getExecutedCalls()[0]).toMatchObject({
      command: "python3",
      args: ["--version"],
      options: { timeoutMs: 100, signal: controller.signal },
    });
  });

  test("logs missing-python failure before returning an optional-feature warning and fix", async () => {
    const commands = new FakeHostCommandExecutor();
    const log = new FakeLogger();
    commands.setCommandError("python3", new Error("ENOENT"));
    expect(await checkPython3({}, { commands, log })).toMatchObject({
      status: "warn",
      recommendation: expect.stringContaining("Install Python 3.11 with venv support"),
    });
    expect(log.at("warn")[0].message).toContain("ENOENT");
    expect(commands.getExecutedCalls()).toHaveLength(1);
  });
});
