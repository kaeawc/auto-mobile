import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  ctrlProxyPidsFromArgsRows,
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
const RUNNER_APP = `/Users/user/Library/Developer/CoreSimulator/Devices/${SIM_UDID}/data/Containers/Bundle/Application/AAAA/CtrlProxyUITests-Runner.app/CtrlProxyUITests-Runner`;

/** The `ps -axo pid=,ppid=,time=` shape of the captured `pid ppid time args` rows. */
function withoutArgs(rows: string): string {
  return rows
    .split("\n")
    .map((line) => line.replace(/^(\s*\d+\s+\d+\s+\S+)\s.*$/, "$1"))
    .join("\n");
}

test("captured ps rows: idle launchd_sim growth is not runner progress; the runner tree and app are", () => {
  const rows = withoutArgs(
    `${fixture}\n90001 1 00:01.00 xcodebuild -destination id=${SIM_UDID}\n` +
      `90002 90001 00:02.00 child\n90003 51665 00:04.00 ${RUNNER_APP}\n90004 90003 00:08.00 helper\n`,
  );
  // xcodebuild 1.00 + child 2.00 + runner app 4.00 + its child 8.00; launchd_sim and
  // its other children (logd, syslogd, modelcatalogd) and unrelated host rows excluded.
  expect(sumRunnerLaunchCpuMs(rows, 90001, [90003])).toBe(15000);
  expect(sumRunnerLaunchCpuMs(rows, 90001, [])).toBe(3000);
  expect(sumRunnerLaunchCpuMs(withoutArgs(fixture), 90001, [])).toBeNull();
});

test("only a udid-matched process whose command line names CtrlProxy is a device root", () => {
  const argsRows =
    `51665 launchd_sim /x/Devices/${SIM_UDID}/data/var/run/launchd_bootstrap.plist\n` +
    `90003 ${RUNNER_APP}\n`;
  expect(ctrlProxyPidsFromArgsRows(argsRows)).toEqual([90003]);
  expect(ctrlProxyPidsFromArgsRows("")).toEqual([]);
});

function newProbe(): { host: FakeHostCommandExecutor; probe: IosCtrlProxyProcessClient } {
  const host = new FakeHostCommandExecutor();
  return { host, probe: new IosCtrlProxyProcessClient(host) };
}

const CPU_TABLE =
  "90001 1 00:01.00\n90002 90001 00:02.00\n90003 51665 00:04.00\n51665 1 00:27.00\n";

test("a busy host's process table is never read with a command column (#15183)", async () => {
  const { host, probe } = newProbe();
  host.setCommandResponse("ps -axo", createExecResult(CPU_TABLE, ""));
  host.setCommandResponse("pgrep -f", createExecResult(`51665\n90003\n`, ""));
  host.setCommandResponse(
    "ps -p",
    createExecResult(`51665 launchd_sim ${SIM_UDID}\n90003 ${RUNNER_APP}\n`, ""),
  );
  expect(await probe.sample(90001, SIM_UDID)).toBe(7000);
  expect(host.getExecutedCommands()).toEqual([
    "ps -axo pid=,ppid=,time=",
    `pgrep -f ${SIM_UDID}`,
    "ps -p 51665,90003 -o pid= -o args= -ww",
  ]);
});

test("no udid-matched process means only the xcodebuild tree counts, with no extra lookup", async () => {
  const { host, probe } = newProbe();
  host.setCommandResponse("ps -axo", createExecResult(CPU_TABLE, ""));
  expect(await probe.sample(90001, "")).toBe(3000);
  expect(host.getExecutedCommands()).toEqual(["ps -axo pid=,ppid=,time="]);
});

function exitOne(stdout: string): Error {
  return Object.assign(new Error("Command failed"), { code: 1, stdout, stderr: "" });
}

test("pgrep finding nothing and every candidate exiting are empty answers, not failures", async () => {
  const none = newProbe();
  none.host.setCommandResponse("ps -axo", createExecResult(CPU_TABLE, ""));
  none.host.setCommandError("pgrep", exitOne(""));
  expect(await none.probe.sample(90001, SIM_UDID)).toBe(3000);

  const gone = newProbe();
  gone.host.setCommandResponse("ps -axo", createExecResult(CPU_TABLE, ""));
  gone.host.setCommandResponse("pgrep -f", createExecResult("90003\n", ""));
  gone.host.setCommandError("ps -p", exitOne(""));
  expect(await gone.probe.sample(90001, SIM_UDID)).toBe(3000);
});

test("ps exiting 1 keeps the rows of the candidates that survived", async () => {
  const { host, probe } = newProbe();
  host.setCommandResponse("ps -axo", createExecResult(CPU_TABLE, ""));
  host.setCommandResponse("pgrep -f", createExecResult("51665\n90003\n", ""));
  host.setCommandError("ps -p", exitOne(`90003 ${RUNNER_APP}\n`));
  expect(await probe.sample(90001, SIM_UDID)).toBe(7000);
});

test("a failing table or lookup yields no sample instead of a partial total", async () => {
  const table = newProbe();
  table.host.setCommandError("ps -axo", new Error("ps unavailable"));
  expect(await table.probe.sample(90001, SIM_UDID)).toBeNull();

  const lookup = newProbe();
  lookup.host.setCommandResponse("ps -axo", createExecResult(CPU_TABLE, ""));
  lookup.host.setCommandError("pgrep", new Error("pgrep unavailable"));
  expect(await lookup.probe.sample(90001, SIM_UDID)).toBeNull();
});
