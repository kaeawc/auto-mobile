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
    read: (signal?: AbortSignal) => read.read(deviceId, signal),
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
  test("S2 a shared listing failure retries once on the other device and detects its foreign client", async () => {
    const first = new FakeAdbExecutor();
    first.setCommandError("forward --list", new Error("first device offline"));
    const second = new FakeAdbExecutor();
    second.setCommandResponse("forward --list", {
      stdout: "second tcp:52001 tcp:8765",
      stderr: "",
    });
    const evidence = new DefaultForeignCtrlProxyForwardEvidence({
      adbFactory: { create: (device) => (device.deviceId === "first" ? first : second) },
      clientProbe: { findClientPids: async () => [4242] },
      ownership: () => ({ ownsForward: () => false }),
      isProcessRunning: () => true,
      timer: new FakeTimer(),
    });
    const [firstVerdict, secondVerdict] = await Promise.all([
      evidence.read("first"),
      evidence.read("second"),
    ]);
    expect(firstVerdict).toMatchObject({
      kind: "unknown",
      ports: [],
      reason: "first device offline",
    });
    expect(secondVerdict).toMatchObject({ kind: "foreign", ports: [52001], clientPids: [4242] });
    expect(first.getExecutedCommands()).toEqual(["forward --list"]);
    expect(second.getExecutedCommands()).toEqual(["forward --list"]);
  });

  test("F2 an already cancelled evidence read preserves its abort reason", async () => {
    const h = harness();
    const controller = new AbortController();
    const abort = new Error("cancelled listing");
    controller.abort(abort);
    await expect(h.read(controller.signal)).rejects.toBe(abort);
    expect(h.adb.getExecutedCommands()).toEqual([]);
  });

  test("F2 cancellation during a failed listing preserves abort rather than unknown", async () => {
    const h = harness();
    const controller = new AbortController();
    const abort = new Error("cancelled during listing");
    h.adb.execute = async () => {
      controller.abort(abort);
      throw new Error("adb stopped");
    };
    await expect(h.read(controller.signal)).rejects.toBe(abort);
    expect(h.ports).toEqual([]);
  });

  test("F2 an adb AbortError is not converted to unknown even without an aborted signal", async () => {
    const h = harness();
    const abort = new DOMException("cancelled", "AbortError");
    h.adb.setCommandError("forward --list", abort);
    await expect(h.read()).rejects.toBe(abort);
  });

  test("F8b memory-only evidence describes a past connection and live PID", async () => {
    const h = harness();
    await h.read();
    h.clients([]);
    const verdict = await h.read();
    expect(verdict.kind).toBe("foreign");
    expect("message" in verdict && verdict.message).toContain(
      "was seen connected to it and is still running",
    );
    expect("message" in verdict && verdict.message).not.toContain("holds a connection to it");
  });

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
