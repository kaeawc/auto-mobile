import { describe, expect, test } from "bun:test";
import {
  findLaunchdSimPid,
  launchdSimPattern,
  parsePgrepPid,
} from "../../../src/utils/ios-cmdline-tools/launchdSimPid";
import { createExecResult } from "../../../src/utils/execResult";
import { FakeHostCommandExecutor } from "../../fakes/FakeHostCommandExecutor";

const UDID = "8FF9478A-DCF6-4A8B-B20B-45D7B8CB3DFC";

describe("launchdSimPid", () => {
  test("matches the device's bootstrap plist on launchd_sim's command line", () => {
    const pattern = new RegExp(launchdSimPattern(UDID));
    const commandLine =
      "launchd_sim /Users/me/Library/Developer/CoreSimulator/Devices/" +
      `${UDID}/data/var/run/launchd_bootstrap.plist`;
    expect(pattern.test(commandLine)).toBe(true);
    expect(pattern.test(commandLine.replace(UDID, "OTHER"))).toBe(false);
  });

  test("parses the first PID and rejects anything else", () => {
    expect(parsePgrepPid("81023\n")).toBe(81023);
    expect(parsePgrepPid("81023\n90000\n")).toBe(81023);
    expect(parsePgrepPid("")).toBeUndefined();
    expect(parsePgrepPid("0\n")).toBeUndefined();
  });

  test("runs a bounded pgrep and returns its PID", async () => {
    const executor = new FakeHostCommandExecutor();
    executor.setCommandResponse("pgrep", createExecResult("81023\n", ""));
    expect(await findLaunchdSimPid(UDID, executor)).toBe(81023);
    const [call] = executor.getExecutedCalls();
    expect(call.command).toBe("pgrep");
    expect(call.args).toEqual(["-f", launchdSimPattern(UDID)]);
    expect(call.options?.timeoutMs).toBeGreaterThan(0);
  });

  test("a pgrep with no match (exit 1) means the simulator is not booted", async () => {
    const executor = new FakeHostCommandExecutor();
    executor.setCommandError("pgrep", new Error("Command failed: exit 1"));
    expect(await findLaunchdSimPid(UDID, executor)).toBeUndefined();
  });
});
