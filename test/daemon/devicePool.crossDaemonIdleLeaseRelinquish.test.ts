import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DeviceOwnedByOtherDaemonError } from "../../src/daemon/deviceAcquisitionRefusals";
import { DevicePool } from "../../src/daemon/devicePool";
import {
  DEVICE_CLAIM_OWNER_STARTUP_GRACE_MS,
  ForwardLeaseForeignDeviceOwnership,
  type DeviceOwnershipFileSource,
} from "../../src/daemon/foreignDeviceOwnership";
import { SessionManager } from "../../src/daemon/sessionManager";
import {
  decideOwnerRelinquish,
  DEFAULT_CTRL_PROXY_FORWARD_LEASE_IDLE_MS,
  type DeviceLeaseOwnerStatus,
  type ForwardLeaseOwnerProbe,
  type ForwardLeaseOwnerReport,
  type ForwardLeaseRelinquishProbe,
  type ForwardLeaseRelinquishReport,
} from "../../src/features/observe/shared/ctrlProxyForwardLeaseOwnership";
import type { LockContent } from "../../src/utils/fileLock";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";

// #11349 (owner decision 2026-10-10): a peer daemon that only holds an idle CtrlProxy forwarding
// lease on a device, with no session and no running tool call, is asked once to relinquish it
// before an explicit bind is refused. The bind is still refused when the peer keeps the lease.

const DEVICE_ID = "emulator-5554";
const DEVICE = { deviceId: DEVICE_ID, name: "Pixel", platform: "android" as const };
const LEASE_PATH = `/leases/${DEVICE_ID}.lock`;

/** One host's lock files, shared by both daemons, with fileLock's semantics. */
class SharedLockFiles {
  readonly files = new Map<string, LockContent>();

  source(): DeviceOwnershipFileSource {
    const files = this.files;
    return {
      leasePath: (deviceId) => `/leases/${deviceId}.lock`,
      claimPath: (deviceId) => `/claims/${deviceId}.lock`,
      legacyClaimPath: () => undefined,
      read: (path) => files.get(path),
      // Liveness is injected: both fake daemons are "running", and no real PID is ever signalled.
      isProcessRunning: () => true,
      tryAcquire: (path, owner) => {
        if (files.has(path)) {
          return false;
        }
        files.set(path, { pid: owner.pid, token: owner.ownerToken, metadata: owner.metadata });
        return true;
      },
      takeOver: (path, observed, owner) => {
        const held = files.get(path);
        if (held?.pid !== observed.pid || held.token !== observed.token) {
          return false;
        }
        files.set(path, { pid: owner.pid, token: owner.ownerToken, metadata: owner.metadata });
        return true;
      },
      release: (path, owner) => {
        const held = files.get(path);
        if (held?.pid === owner.pid && held.token === owner.ownerToken) {
          files.delete(path);
        }
      },
    };
  }
}

interface Peer {
  pid: number;
  pool?: DevicePool;
  activeExecutions: number;
  idleForMs: number | null;
}

/** Each daemon's control socket, answered in-process from that daemon's own state. */
class PeerSockets implements ForwardLeaseOwnerProbe, ForwardLeaseRelinquishProbe {
  readonly peers = new Map<string, Peer>();
  readonly relinquishRequests: string[] = [];

  constructor(private readonly files: SharedLockFiles) {}

  private statusOf(peer: Peer, deviceId: string): DeviceLeaseOwnerStatus {
    return {
      pid: peer.pid,
      deviceId,
      sessionId: peer.pool?.getDevice(deviceId)?.sessionId ?? null,
      activeExecutions: peer.activeExecutions,
      idleForMs: peer.idleForMs,
    };
  }

  async query(socketPath: string, deviceId: string): Promise<ForwardLeaseOwnerReport> {
    const peer = this.peers.get(socketPath);
    return peer
      ? { kind: "status", status: this.statusOf(peer, deviceId) }
      : { kind: "unreachable", detail: "ENOENT" };
  }

  /** The owner side: the real relinquish decision, then the lease file is given up. */
  async requestRelinquish(
    socketPath: string,
    deviceId: string,
  ): Promise<ForwardLeaseRelinquishReport> {
    this.relinquishRequests.push(`${socketPath}:${deviceId}`);
    const peer = this.peers.get(socketPath);
    if (!peer) {
      return { kind: "unreachable", detail: "ENOENT" };
    }
    const status = this.statusOf(peer, deviceId);
    const decision = decideOwnerRelinquish(status, DEFAULT_CTRL_PROXY_FORWARD_LEASE_IDLE_MS);
    if (decision.release && this.files.files.get(LEASE_PATH)?.pid === peer.pid) {
      this.files.files.delete(LEASE_PATH);
    }
    return {
      kind: "relinquish",
      result: { ...status, released: decision.release, reason: decision.reason },
    };
  }
}

const A_PID = 1111;
const B_PID = 2222;
const A_SOCKET = "/sockets/a.sock";
const B_SOCKET = "/sockets/b.sock";

describe("explicit bind against a peer's idle forwarding lease (#11349)", () => {
  let timer: FakeTimer;
  let files: SharedLockFiles;
  let sockets: PeerSockets;
  const managers: SessionManager[] = [];

  const daemon = async (pid: number, socketPath: string) => {
    const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
    managers.push(sessions);
    const devices = new FakeDeviceManager();
    devices.bootedDevices = [DEVICE];
    const pool = new DevicePool(
      createDevicePoolDependencies(sessions, `daemon-${pid}`, {
        timer,
        deviceManager: devices,
        retryExecutor: new DefaultRetryExecutor(timer),
        installedAppsRepository: new FakeInstalledAppsRepository(),
        foreignDeviceOwnership: new ForwardLeaseForeignDeviceOwnership(
          pid,
          files.source(),
          sockets,
          () => socketPath,
          timer,
        ),
      }),
    );
    await pool.initializeWithDevices([DEVICE]);
    const peer: Peer = { pid, pool, activeExecutions: 0, idleForMs: null };
    sockets.peers.set(socketPath, peer);
    return { sessions, pool, peer };
  };

  /** B's CtrlProxy client took the forwarding lease, as it does on first contact with a device. */
  const leaseHeldByB = () =>
    files.files.set(LEASE_PATH, {
      pid: B_PID,
      token: "b-lease",
      metadata: JSON.stringify({ socketPath: B_SOCKET, acquiredAt: 1 }),
    });

  const bind = (pool: DevicePool) =>
    pool.bindOrReuseDeviceSession("a-session", DEVICE_ID, "android").then(
      () => undefined,
      (error: unknown) => error,
    );

  beforeEach(() => {
    timer = new FakeTimer();
    timer.setCurrentTime(1 + DEVICE_CLAIM_OWNER_STARTUP_GRACE_MS);
    files = new SharedLockFiles();
    sockets = new PeerSockets(files);
  });
  afterEach(() => {
    for (const sessions of managers.splice(0)) {
      sessions.stopCleanupTimer();
    }
    timer.reset();
  });

  test("an idle lease holder with no session relinquishes, and the bind succeeds", async () => {
    const a = await daemon(A_PID, A_SOCKET);
    const b = await daemon(B_PID, B_SOCKET);
    b.peer.idleForMs = DEFAULT_CTRL_PROXY_FORWARD_LEASE_IDLE_MS + 1_000;
    leaseHeldByB();

    expect(await bind(a.pool)).toBeUndefined();

    expect(sockets.relinquishRequests).toEqual([`${B_SOCKET}:${DEVICE_ID}`]);
    expect(files.files.has(LEASE_PATH)).toBe(false);
    expect(a.pool.getDevice(DEVICE_ID)?.sessionId).toBe("a-session");
    expect(files.files.get(`/claims/${DEVICE_ID}.lock`)?.pid).toBe(A_PID);
  });

  test("a lease holder with a session keeps the device, and is never asked to relinquish", async () => {
    const a = await daemon(A_PID, A_SOCKET);
    const b = await daemon(B_PID, B_SOCKET);
    await b.pool.bindOrReuseDeviceSession("b-session", DEVICE_ID, "android");
    leaseHeldByB();

    const refusal = await bind(a.pool);

    expect(refusal).toBeInstanceOf(DeviceOwnedByOtherDaemonError);
    expect(refusal).toMatchObject({ ownerPid: B_PID });
    expect(sockets.relinquishRequests).toEqual([]);
    expect(files.files.get(LEASE_PATH)?.pid).toBe(B_PID);
    expect(a.pool.getDevice(DEVICE_ID)?.sessionId ?? null).toBeNull();
  });

  test("a lease holder with a tool call in flight keeps the device", async () => {
    const a = await daemon(A_PID, A_SOCKET);
    const b = await daemon(B_PID, B_SOCKET);
    b.peer.activeExecutions = 1;
    leaseHeldByB();

    const refusal = await bind(a.pool);

    expect(refusal).toBeInstanceOf(DeviceOwnedByOtherDaemonError);
    expect(refusal).toMatchObject({ ownerPid: B_PID });
    expect(sockets.relinquishRequests).toEqual([]);
    expect(files.files.get(LEASE_PATH)?.pid).toBe(B_PID);
  });

  test("a holder that declines the one request keeps the device", async () => {
    const a = await daemon(A_PID, A_SOCKET);
    const b = await daemon(B_PID, B_SOCKET);
    // Used within the holder's own idle window: its relinquish decision is to keep the lease.
    b.peer.idleForMs = 5_000;
    leaseHeldByB();

    const refusal = await bind(a.pool);

    expect(refusal).toBeInstanceOf(DeviceOwnedByOtherDaemonError);
    expect(refusal).toMatchObject({ ownerPid: B_PID });
    expect(sockets.relinquishRequests).toHaveLength(1);
    expect(files.files.get(LEASE_PATH)?.pid).toBe(B_PID);
  });
});
