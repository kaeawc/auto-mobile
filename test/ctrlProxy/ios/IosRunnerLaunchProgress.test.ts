import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  parseProcessCpuTimeMs,
  sumRunnerLaunchCpuMs,
} from "../../../src/ctrlProxy/ios/IosRunnerLaunchProgress";
import { IosCtrlProxyProcessClient } from "../../../src/ctrlProxy/ios/IosCtrlProxyProcessClient";
import { FakeHostCommandExecutor } from "../../fakes/FakeHostCommandExecutor";
import { createExecResult } from "../../../src/utils/execResult";

const fixture = readFileSync(
  new URL("../../fixtures/ios-runner-progress/ps-captured.txt", import.meta.url),
  "utf8",
);

test.each([
  ["00:01.23", 1230],
  ["2:03", 123000],
  ["01:02:03", 3723000],
  ["2-01:02:03", 176523000],
  ["bad", null],
  ["1:99", null],
])("CPU time %s parses as %s", (value, expected) => {
  expect(parseProcessCpuTimeMs(String(value))).toBe(expected);
});

const SIM_UDID = "18A2D9B1-CDFA-445A-93AA-A532EA4B5498";

test("captured ps rows sum the device's launchd_sim children plus the runner tree exactly once", () => {
  // launchd_sim 27.98 + logd 14.94 + syslogd 0.18 + modelcatalogd 1.34 (children of 51665),
  // plus the xcodebuild root 1.00 and its child 2.00; the unrelated host rows are excluded.
  const rows = `${fixture}\n90001 1 00:01.00 xcodebuild -destination id=${SIM_UDID}\n90002 90001 00:02.00 child\n`;
  expect(sumRunnerLaunchCpuMs(rows, 90001, SIM_UDID)).toBe(47440);
  expect(sumRunnerLaunchCpuMs(rows, 90001, "OTHER-UDID")).toBe(3000);
  expect(sumRunnerLaunchCpuMs(fixture, 90001, SIM_UDID)).toBeNull();
});

test("probe uses one ps command and returns null on command failure", async () => {
  const host = new FakeHostCommandExecutor();
  host.setCommandResponse("ps", createExecResult("90001 1 00:01.00 xcodebuild", ""));
  const probe = new IosCtrlProxyProcessClient(host);
  expect(await probe.sample(90001, "DEVICE")).toBe(1000);
  expect(host.getExecutedCommands()).toEqual(["ps -axo pid=,ppid=,time=,args= -ww"]);
  host.setCommandError("ps", new Error("ps unavailable"));
  expect(await probe.sample(90001, "DEVICE")).toBeNull();
});
