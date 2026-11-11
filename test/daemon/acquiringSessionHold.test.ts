import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { holdAcquiringSession } from "../../src/daemon/acquiringSessionHold";
import { ExecutionTracker } from "../../src/daemon/executionTracker";
import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DEFAULT_PRE_FIRST_HEARTBEAT_GRACE_MS } from "../../src/daemon/sessionManager/sessionConstants";
import { DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS } from "../../src/daemon/wire/sessionLivenessWindows";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";

const GRACE_ENV_KEYS = [
  "AUTOMOBILE_SESSION_PRE_FIRST_HEARTBEAT_GRACE_MS",
  "AUTO_MOBILE_SESSION_PRE_FIRST_HEARTBEAT_GRACE_MS",
] as const;

/** A provisionDevice run's budget: comfortably longer than the 30 s of post-bind work below. */
const PROVISION_BUDGET_MS = 120_000;
const PROVISION_STEPS_MS = 30_000;

describe("holdAcquiringSession (#17885)", () => {
  let timer: FakeTimer;
  let sessionManager: SessionManager;
  let tracker: ExecutionTracker;
  let reaped: Array<{ sessionId: string; reason: string }>;
  let monitor: SessionHeartbeatMonitor;
  let savedEnv: Array<[string, string | undefined]>;

  beforeEach(() => {
    savedEnv = GRACE_ENV_KEYS.map((key) => [key, process.env[key]]);
    for (const key of GRACE_ENV_KEYS) {
      delete process.env[key];
    }
    timer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    tracker = new ExecutionTracker(timer, new FakeIdGenerator());
    reaped = [];
    // The daemon's own probe shape: explicit session executions and their request deadlines.
    monitor = new SessionHeartbeatMonitor(
      sessionManager,
      {
        hasActiveExecutions: (id) => tracker.hasActiveSessionUuidExecutions(id),
        latestExecutionDeadlineMs: (id) => tracker.getLatestSessionExecutionDeadlineMs(id),
      },
      async (sessionId, reason) => {
        reaped.push({ sessionId, reason });
        await sessionManager.releaseSession(sessionId);
      },
      { timer },
    );
  });

  afterEach(() => {
    sessionManager.stopCleanupTimer();
    for (const [key, value] of savedEnv) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  /** Scan the way the monitor's interval does, one check interval at a time. */
  async function runFor(ms: number): Promise<void> {
    for (let elapsed = 0; elapsed < ms; elapsed += DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS) {
      timer.advanceTime(DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS);
      await monitor.tick();
    }
  }

  async function mint(sessionId: string): Promise<void> {
    await sessionManager.createSession(sessionId, "emulator-5560", "android", {
      timeoutMs: 600_000,
    });
  }

  it("a 30 s provision is not reaped for its missing first heartbeat while it holds the session", async () => {
    await mint("provisioned");
    const { release } = holdAcquiringSession(tracker, sessionManager, {
      toolName: "provisionDevice",
      sessionUuid: "provisioned",
      deadlineMs: timer.now() + PROVISION_BUDGET_MS,
    });

    await runFor(PROVISION_STEPS_MS);
    release();

    expect(reaped).toEqual([]);
    expect(sessionManager.getSession("provisioned")).toBeDefined();
  });

  it("an abandoned session with no hold is still reaped after the pre-first-heartbeat grace", async () => {
    await mint("abandoned");

    await runFor(6_000);

    expect(reaped).toEqual([{ sessionId: "abandoned", reason: "missing-first-heartbeat" }]);
  });

  it("releasing the hold restarts the pre-first-heartbeat grace instead of using it up", async () => {
    await mint("provisioned");
    const generation = sessionManager.getSession("provisioned")!.activityGeneration;
    const { release } = holdAcquiringSession(tracker, sessionManager, {
      toolName: "provisionDevice",
      sessionUuid: "provisioned",
      deadlineMs: timer.now() + PROVISION_BUDGET_MS,
    });
    await runFor(PROVISION_STEPS_MS);
    release();
    release();
    expect(tracker.hasActiveSessionUuidExecutions("provisioned")).toBe(false);
    expect(sessionManager.getSession("provisioned")!.activityGeneration).toBe(generation);

    // Scans inside the restarted grace keep the session for the client's first heartbeat.
    await runFor(
      DEFAULT_PRE_FIRST_HEARTBEAT_GRACE_MS - DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS,
    );
    expect(reaped).toEqual([]);

    // Past the grace with no heartbeat, the abandoned session is reaped as before.
    await runFor(2 * DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS);
    expect(reaped).toEqual([{ sessionId: "provisioned", reason: "missing-first-heartbeat" }]);
  });

  it("the hold's signal aborts when the daemon cancels the held session's work", async () => {
    await mint("provisioned");
    const { signal, release } = holdAcquiringSession(tracker, sessionManager, {
      toolName: "provisionDevice",
      sessionUuid: "provisioned",
      deadlineMs: timer.now() + PROVISION_BUDGET_MS,
    });
    expect(signal.aborted).toBe(false);

    await tracker.cancelDeviceSessionExecutions("provisioned", "device lost");

    expect(signal.aborted).toBe(true);
    release();
  });

  it("a run that wedges past its deadline stops holding the session", async () => {
    await mint("wedged");
    holdAcquiringSession(tracker, sessionManager, {
      toolName: "provisionDevice",
      sessionUuid: "wedged",
      deadlineMs: timer.now() + PROVISION_STEPS_MS,
    });

    // Past the deadline plus the veto's 10 s unwind grace, the never-released hold expires.
    await runFor(PROVISION_STEPS_MS + 12_000);

    expect(reaped).toEqual([{ sessionId: "wedged", reason: "missing-first-heartbeat" }]);
  });
});
