import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEVICE_LEASE_RELINQUISH_TIMEOUT_MS,
  DaemonDeviceLeaseOwnerProbe,
  rawDaemonSocketExchange,
  type DaemonSocketExchange,
  type DaemonSocketExchangeOutcome,
} from "../../src/daemon/deviceLeaseOwnerQuery";
import {
  DAEMON_DEVICE_LEASE_STATUS_METHOD,
  DAEMON_RELINQUISH_DEVICE_LEASE_METHOD,
} from "../../src/daemon/constants";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { defaultTimer } from "../../src/utils/SystemTimer";
import { FakeTimer } from "../fakes/FakeTimer";

function probeAnswering(outcome: DaemonSocketExchangeOutcome) {
  const frames: string[] = [];
  const exchange: DaemonSocketExchange = async (_socketPath, frame) => {
    frames.push(frame);
    return outcome;
  };
  return {
    frames,
    probe: new DaemonDeviceLeaseOwnerProbe(exchange, new FakeTimer(), new CountingIdGenerator("q")),
  };
}

const status = {
  pid: 4242,
  deviceId: "emulator-5600",
  sessionId: "session-1",
  activeExecutions: 0,
  idleForMs: 5,
};

describe("DaemonDeviceLeaseOwnerProbe (#10497)", () => {
  let dir: string | undefined;
  let server: Server | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  test("sends one daemon request and maps a status answer", async () => {
    const { probe, frames } = probeAnswering({
      kind: "response",
      line: JSON.stringify({ id: "q-1", type: "mcp_response", success: true, result: status }),
    });
    expect(await probe.query("/tmp/priv.sock", "emulator-5600")).toEqual({
      kind: "status",
      status,
    });
    expect(frames).toHaveLength(1);
    expect(frames[0]!.endsWith("\n")).toBe(true);
    expect(JSON.parse(frames[0]!)).toMatchObject({
      type: "daemon_request",
      method: DAEMON_DEVICE_LEASE_STATUS_METHOD,
      params: { deviceId: "emulator-5600" },
    });
  });

  test("maps connect failures to unreachable and silence to no-response", async () => {
    expect(
      await probeAnswering({ kind: "connect-failed", detail: "ECONNREFUSED" }).probe.query(
        "/tmp/priv.sock",
        "emulator-5600",
      ),
    ).toEqual({ kind: "unreachable", detail: "ECONNREFUSED" });
    expect(
      (await probeAnswering({ kind: "timeout" }).probe.query("/tmp/priv.sock", "emulator-5600"))
        .kind,
    ).toBe("no-response");
  });

  test("maps an older daemon's unsupported-method error to unsupported", async () => {
    const report = await probeAnswering({
      kind: "response",
      line: JSON.stringify({
        id: "q-1",
        success: false,
        error: "Unsupported daemon method: daemon/deviceLeaseStatus",
      }),
    }).probe.query("/tmp/priv.sock", "emulator-5600");
    expect(report).toEqual({
      kind: "unsupported",
      detail: "Unsupported daemon method: daemon/deviceLeaseStatus",
    });
  });

  test("asks the owner to relinquish and maps its answer (#10506 review)", async () => {
    const answer = { ...status, released: false, reason: "it has live session session-1" };
    const { probe, frames } = probeAnswering({
      kind: "response",
      line: JSON.stringify({ id: "q-1", type: "mcp_response", success: true, result: answer }),
    });
    expect(await probe.requestRelinquish("/tmp/priv.sock", "emulator-5600")).toEqual({
      kind: "relinquish",
      result: answer,
    });
    expect(JSON.parse(frames[0]!)).toMatchObject({
      type: "daemon_request",
      method: DAEMON_RELINQUISH_DEVICE_LEASE_METHOD,
      params: { deviceId: "emulator-5600" },
      timeoutMs: DEVICE_LEASE_RELINQUISH_TIMEOUT_MS,
    });
  });

  test("treats a relinquish answer without a decision as unsupported", async () => {
    const report = await probeAnswering({
      kind: "response",
      line: JSON.stringify({ id: "q-1", success: true, result: status }),
    }).probe.requestRelinquish("/tmp/priv.sock", "emulator-5600");
    expect(report).toEqual({ kind: "unsupported", detail: "unexpected response shape" });
  });

  test("the raw exchange reports a missing socket as a connect failure", async () => {
    dir = mkdtempSync(join(tmpdir(), "lease-q-"));
    const outcome = await rawDaemonSocketExchange(
      join(dir, "none.sock"),
      "{}\n",
      1_000,
      defaultTimer,
    );
    expect(outcome.kind).toBe("connect-failed");
  });

  test("the raw exchange returns the first response line", async () => {
    dir = mkdtempSync(join(tmpdir(), "lease-q-"));
    const socketPath = join(dir, "d.sock");
    server = createServer((socket) => {
      socket.once("data", () => socket.write('{"success":true}\n{"ignored":true}\n'));
    });
    await new Promise<void>((resolve) => server!.listen(socketPath, resolve));
    expect(await rawDaemonSocketExchange(socketPath, "{}\n", 1_000, defaultTimer)).toEqual({
      kind: "response",
      line: '{"success":true}',
    });
  });
});
