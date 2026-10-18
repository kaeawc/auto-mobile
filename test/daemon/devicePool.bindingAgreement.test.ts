import { makePool } from "../helpers/makePool";
import { expect, test } from "bun:test";
import { SessionManager } from "../../src/daemon/sessionManager";
import { holderOf } from "../../src/daemon/deviceBinding";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { SeededRandom } from "../fakes/SeededRandom";
import { drainUntilQuiescent } from "../helpers/fakeTimerStepping";
import { useSessionIdleWindowForSuite } from "../helpers/sessionIdleWindowEnv";

// #11802: the pool's holder of a device (deviceBinding.holderOf) and the session manager's reverse
// lookup (getSessionForDevice) are two views of one binding. At every quiescent point of a random
// acquire / release / expire / rebind sequence they must name the same session.

useSessionIdleWindowForSuite();

const DEVICES = ["emulator-5554", "emulator-5556", "emulator-5558"].map((deviceId) => ({
  deviceId,
  name: deviceId,
  platform: "android" as const,
}));
const STEPS = 30;
const SEEDS = [1, 7, 42, 1234];
const TTL_MS = 1_000;

type Op = "acquire" | "release" | "expire" | "rebind";
// Weighted toward the state-building ops so most steps change a binding rather than no-op.
const OPS: readonly Op[] = [
  "acquire",
  "acquire",
  "acquire",
  "release",
  "expire",
  "rebind",
  "rebind",
];

async function run(seed: number): Promise<string[]> {
  const random = new SeededRandom(seed);
  const timer = new FakeTimer();
  const manager = new SessionManager(timer, new FakeDeviceSessionPersistence(), {
    barrier: () => new FakeDbWriteBarrier(),
  });
  const utils = new FakeDeviceUtils();
  utils.setBootedDevices("android", DEVICES);
  const pool = makePool(manager, "agreement-daemon", { timer, deviceManager: utils });
  await pool.initializeWithDevices(DEVICES);
  manager.stopCleanupTimer();

  const trace: string[] = [];
  // Terminal session ids are never reused, so each acquire mints a fresh one.
  const live: string[] = [];
  let minted = 0;
  const assertAgreement = (label: string) => {
    for (const { deviceId } of DEVICES) {
      const poolHolder = holderOf(pool.getDevice(deviceId));
      const sessionHolder = manager.getSessionForDevice(deviceId);
      expect({ seed, trace, label, deviceId, holder: poolHolder ?? null }).toEqual({
        seed,
        trace,
        label,
        deviceId,
        holder: sessionHolder,
      });
    }
  };

  for (let step = 0; step < STEPS; step++) {
    const op = live.length === 0 ? "acquire" : random.pick(OPS);
    const deviceId = random.pick(DEVICES).deviceId;
    const sessionId = op === "acquire" ? `s${minted++}` : live.length ? random.pick(live) : "none";
    const free = manager.getSessionForDevice(deviceId) === null;
    trace.push(`${op}:${sessionId}:${deviceId}`);
    try {
      if (op === "acquire" && free) {
        await manager.createSession(sessionId, deviceId, "android", {
          timeoutMs: TTL_MS,
          heartbeatTimeoutMs: TTL_MS,
        });
        await pool.bindOrReuseDeviceSession(sessionId, deviceId, "android");
        live.push(sessionId);
      } else if (op === "release" && live.includes(sessionId)) {
        live.splice(live.indexOf(sessionId), 1);
        const released = await manager.releaseSession(sessionId, "explicit-release");
        // Caller-driven release captures the device until the caller returns it to the pool.
        if (released) {
          await pool.releaseDevice(released, sessionId);
        }
      } else if (op === "expire") {
        timer.advanceTime(TTL_MS + 1);
        manager.cleanupExpiredSessions();
        live.length = 0;
      } else if (op === "rebind" && free && manager.getSession(sessionId)) {
        await pool.bindOrReuseDeviceSession(
          sessionId,
          deviceId,
          "android",
          undefined,
          undefined,
          undefined,
          true,
        );
      }
    } catch (error) {
      // Refused operations (device held by another session) are legal outcomes; the invariant
      // must hold after them too.
      trace.push(`refused:${error instanceof Error ? error.constructor.name : "unknown"}`);
    }
    await drainUntilQuiescent(timer);
    assertAgreement(`after step ${step}`);
  }
  manager.stopCleanupTimer();
  return trace;
}

test.each(SEEDS)("pool holder agrees with session reverse lookup (seed %d)", async (seed) => {
  const trace = await run(seed);
  expect(trace.filter((t) => t.startsWith("refused"))).toEqual([]);
});
