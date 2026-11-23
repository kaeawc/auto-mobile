import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  simulatorProcessTree,
  parsePsSnapshot,
} from "../../../../src/devices/bootAdmission/psSnapshot";
import { readIosSimulatorNetworkActivity } from "../../../../src/features/utility/networkActivity/IosSimulatorNetworkActivity";
import {
  parseLsofInternetSockets,
  parseNettopProcessBytes,
} from "../../../../src/features/utility/networkActivity/networkActivityParsers";
import { createExecResult } from "../../../../src/utils/execResult";
import { FakeHostCommandExecutor } from "../../../fakes/FakeHostCommandExecutor";

const FIXTURES = join(import.meta.dir, "../../../fixtures/ios-sim-network-activity");
const PS = readFileSync(join(FIXTURES, "ps-simulator-tree.txt"), "utf8");
const LSOF = readFileSync(join(FIXTURES, "lsof-internet-sockets.txt"), "utf8");
const NETTOP = readFileSync(join(FIXTURES, "nettop-process-bytes.txt"), "utf8");
const UDID = "E32B356F-D6E3-427D-A0CC-2BDA07C5CFCF";
const PROBE_PID = 15965;
const PROBE_APP = {
  CFBundleIdentifier: "dev.automobile.netprobe19020",
  Path: `/Users/user/Library/Developer/CoreSimulator/Devices/${UDID}/data/Containers/Bundle/Application/EE89037E-A200-48B0-ABD1-65A32805EDB8/NetProbe.app`,
};

function fakeHost(): FakeHostCommandExecutor {
  const host = new FakeHostCommandExecutor();
  host.setCommandResponse("ps -axo", createExecResult(PS, ""));
  host.setCommandResponse("lsof", createExecResult(LSOF, ""));
  host.setCommandResponse("nettop", createExecResult(NETTOP, ""));
  return host;
}

describe("network activity parsers (#19020)", () => {
  test("lsof sockets carry protocol, endpoints and TCP state", () => {
    const processes = parseLsofInternetSockets(LSOF);
    const probe = processes.find((process) => process.pid === PROBE_PID);
    expect(probe).toEqual({
      pid: PROBE_PID,
      command: "NetProbe",
      sockets: [
        {
          protocol: "TCP",
          local: "127.0.0.1:62949",
          remote: "127.0.0.1:47120",
          state: "ESTABLISHED",
        },
      ],
    });
    const configd = processes.find((process) => process.command === "configd_sim");
    expect(configd?.sockets).toEqual([{ protocol: "UDP", local: "*:*" }]);
    expect(processes.every((process) => process.sockets.length > 0)).toBe(true);
  });

  test("nettop rows keep names with dots and the per-pid byte totals", () => {
    const bytes = parseNettopProcessBytes(NETTOP);
    expect(bytes.get(PROBE_PID)).toEqual({
      pid: PROBE_PID,
      name: "NetProbe",
      bytesIn: 2424879,
      bytesOut: 207,
    });
    expect(bytes.get(37450)?.name).toBe("intelligenceflo");
    expect(bytes.size).toBe(11);
  });

  test("the simulator tree holds launchd_sim and its descendants, not host launchd", () => {
    const tree = simulatorProcessTree(parsePsSnapshot(PS).rows, UDID);
    expect(tree).toHaveLength(310);
    expect(tree.some((row) => row.pid === 1)).toBe(false);
    expect(tree.some((row) => row.pid === PROBE_PID)).toBe(true);
    expect(
      simulatorProcessTree(parsePsSnapshot(PS).rows, "00000000-0000-0000-0000-000000000000"),
    ).toEqual([]);
  });
});

describe("readIosSimulatorNetworkActivity (#19020)", () => {
  test("attributes the app's socket and traffic by its bundle path", async () => {
    const host = fakeHost();
    const state = await readIosSimulatorNetworkActivity(UDID, {
      host,
      listApps: async () => [PROBE_APP],
    });
    expect(state.supported).toBe(true);
    expect(state.processCount).toBe(310);
    expect(state.processes?.find((process) => process.pid === PROBE_PID)).toEqual({
      pid: PROBE_PID,
      name: "NetProbe",
      appId: "dev.automobile.netprobe19020",
      sockets: [
        {
          protocol: "TCP",
          local: "127.0.0.1:62949",
          remote: "127.0.0.1:47120",
          state: "ESTABLISHED",
        },
      ],
      bytesIn: 2424879,
      bytesOut: 207,
    });
    expect(state.processes?.filter((process) => process.appId)).toHaveLength(1);
    expect(state.processes?.some((process) => process.pid === 1)).toBe(false);
    const lsof = host.getExecutedCalls().find((call) => call.command === "lsof");
    expect(lsof?.args.slice(0, 4)).toEqual(["-nP", "-a", "-i", "-p"]);
    expect(lsof?.args[4]?.split(",")).toHaveLength(310);
  });

  test("a runtime-root app path under /private matches the /var executable ps shows", async () => {
    const ps = `    1     0  35248   1.2 /sbin/launchd
  100     1  24224   0.4 launchd_sim /Users/user/Library/Developer/CoreSimulator/Devices/${UDID}/data/var/run/launchd_bootstrap.plist
  200   100  1000   0.0 /var/run/x/RuntimeRoot/Applications/MobileSafari.app/MobileSafari
`;
    const host = new FakeHostCommandExecutor();
    host.setCommandResponse("ps -axo", createExecResult(ps, ""));
    host.setCommandResponse(
      "lsof",
      createExecResult("p200\ncMobileSafari\nf9\nPTCP\nn127.0.0.1:8765\nTST=LISTEN\n", ""),
    );
    host.setCommandResponse("nettop", createExecResult(",bytes_in,bytes_out,\n", ""));
    const state = await readIosSimulatorNetworkActivity(UDID, {
      host,
      listApps: async () => [
        {
          CFBundleIdentifier: "com.apple.mobilesafari",
          Path: "/private/var/run/x/RuntimeRoot/Applications/MobileSafari.app",
        },
      ],
    });
    expect(state.processes).toEqual([
      {
        pid: 200,
        name: "MobileSafari",
        appId: "com.apple.mobilesafari",
        sockets: [{ protocol: "TCP", local: "127.0.0.1:8765", state: "LISTEN" }],
        bytesIn: 0,
        bytesOut: 0,
      },
    ]);
  });

  test("lsof exiting 1 with no output means no sockets, not a failure", async () => {
    const host = fakeHost();
    host.setCommandError(
      "lsof",
      Object.assign(new Error("Command failed: lsof"), { code: 1, stdout: "" }),
    );
    const state = await readIosSimulatorNetworkActivity(UDID, { host, listApps: async () => [] });
    expect(state.error).toBeUndefined();
    expect(state.processes?.every((process) => process.sockets.length === 0)).toBe(true);
    expect(state.processes?.find((process) => process.pid === PROBE_PID)?.bytesIn).toBe(2424879);
  });

  test("any other lsof failure is thrown", async () => {
    const host = fakeHost();
    host.setCommandError("lsof", Object.assign(new Error("lsof: timed out"), { code: 2 }));
    await expect(
      readIosSimulatorNetworkActivity(UDID, { host, listApps: async () => [] }),
    ).rejects.toThrow("Failed to list simulator sockets with lsof");
  });

  test("a simulator with no launchd_sim tree reports an error without running lsof", async () => {
    const host = fakeHost();
    const state = await readIosSimulatorNetworkActivity("00000000-0000-0000-0000-000000000000", {
      host,
      listApps: async () => [],
    });
    expect(state.supported).toBe(true);
    expect(state.error).toContain("is it booted?");
    expect(host.wasCommandExecuted("lsof")).toBe(false);
  });
});
