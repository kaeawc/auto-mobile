import { afterEach, describe, expect, test } from "bun:test";
import {
  DefaultForeignCtrlProxyForwardEvidence,
  resetForeignCtrlProxyForwardEvidenceForTesting,
} from "../../../../src/features/observe/android/foreignCtrlProxyForwardEvidence";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../../fakes/FakeTimer";

const deviceId = "evidence-test-device";
afterEach(resetForeignCtrlProxyForwardEvidenceForTesting);

function harness() {
  const adb = new FakeAdbExecutor();
  let rows = `${deviceId} tcp:52001 tcp:8765`;
  let clients = [4242];
  let alive = true;
  let recorded = false;
  let probeError: Error | undefined;
  const ports: number[] = [];
  const read = new DefaultForeignCtrlProxyForwardEvidence({
    adbFactory: {
      create: () => {
        adb.setCommandResponse("forward --list", { stdout: rows, stderr: "" });
        return adb;
      },
    },
    clientProbe: {
      findClientPids: async (port) => {
        ports.push(port);
        if (probeError) {
          throw probeError;
        }
        return clients;
      },
    },
    ownership: () => ({
      ownsForward: () => recorded,
      ownershipDirectory: () => "/fake-coordination",
    }),
    isProcessRunning: () => alive,
    timer: new FakeTimer(),
  });
  return {
    read: () => read.read(deviceId),
    adb,
    ports,
    rows: (value: string) => {
      rows = value;
    },
    clients: (value: number[]) => {
      clients = value;
    },
    alive: (value: boolean) => {
      alive = value;
    },
    recorded: (value: boolean) => {
      recorded = value;
    },
    failProbe: () => {
      probeError = new Error("TCP table unavailable");
    },
  };
}

describe("foreign CtrlProxy forward evidence", () => {
  test("#12220 connected foreign PID is remembered until its process is provably dead", async () => {
    const h = harness();
    expect(await h.read()).toMatchObject({ kind: "foreign", ports: [52001], clientPids: [4242] });
    h.clients([]);
    expect(await h.read()).toMatchObject({ kind: "foreign", clientPids: [4242] });
    h.alive(false);
    expect(await h.read()).toEqual({ kind: "none" });
    expect(h.adb.getExecutedCommands()).toEqual([
      "forward --list",
      "forward --list",
      "forward --list",
    ]);
  });

  test("#12220 independent readers share remembered foreign PIDs", async () => {
    const first = harness();
    await first.read();
    const second = harness();
    second.clients([]);
    expect(await second.read()).toMatchObject({ kind: "foreign", clientPids: [4242] });
  });

  test("#12220 forward disappearance forgets a remembered live PID", async () => {
    const h = harness();
    await h.read();
    h.rows("");
    expect(await h.read()).toEqual({ kind: "none" });
    h.rows(`${deviceId} tcp:52001 tcp:8765`);
    h.clients([]);
    expect(await h.read()).toEqual({ kind: "none" });
  });

  test("#12220 recorded forwards and this process's own client are not foreign", async () => {
    const h = harness();
    h.recorded(true);
    expect(await h.read()).toEqual({ kind: "none" });
    expect(h.ports).toEqual([]);
    h.recorded(false);
    h.clients([process.pid]);
    expect(await h.read()).toEqual({ kind: "none" });
  });

  test("#12220 a recorded forward clears remembered foreign evidence", async () => {
    const h = harness();
    await h.read();
    h.recorded(true);
    expect(await h.read()).toEqual({ kind: "none" });
    h.recorded(false);
    h.clients([]);
    expect(await h.read()).toEqual({ kind: "none" });
  });

  test("#12220 failed host probe is unknown with the unrecorded ports", async () => {
    const h = harness();
    h.failProbe();
    const verdict = await h.read();
    expect(verdict).toMatchObject({
      kind: "unknown",
      ports: [52001],
      reason: "TCP table unavailable",
    });
    expect("message" in verdict && verdict.message).toContain(
      `adb -s ${deviceId} forward --remove tcp:52001`,
    );
  });

  test("#12220 failed forward listing is unknown without invented ports", async () => {
    const h = harness();
    h.adb.setCommandError("forward --list", new Error("adb offline"));
    expect(await h.read()).toMatchObject({ kind: "unknown", ports: [], reason: "adb offline" });
    expect(h.ports).toEqual([]);
  });

  test("#12220 only exact rows for this device's CtrlProxy remote port are considered", async () => {
    const h = harness();
    h.rows(
      `other tcp:52001 tcp:8765\n${deviceId} tcp:52002 tcp:8888\n${deviceId} tcp:52003 tcp:8765 extra\n${deviceId} localabstract:other tcp:8765`,
    );
    expect(await h.read()).toEqual({ kind: "none" });
    expect(h.ports).toEqual([]);
  });

  test("#12220 connected PID is foreign even if a concurrent liveness probe sees death", async () => {
    const h = harness();
    h.alive(false);
    expect(await h.read()).toMatchObject({ kind: "foreign", clientPids: [4242] });
  });
});
