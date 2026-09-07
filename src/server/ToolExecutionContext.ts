import { SessionManager } from "../daemon/sessionManager";
import type { Session, SessionExecutionMetadata } from "../daemon/sessionManager";
import { DevicePool } from "../daemon/devicePool";
import { getDeviceReadinessProxyDriver } from "./deviceReadinessProxyProvider";
import { NavigationGraphManager } from "../features/navigation/NavigationGraphManager";
import { ActionableError, BootedDevice, Platform } from "../models";
import { logger } from "../utils/logger";
import { KeepScreenAwakeManager, KeepScreenAwakeState } from "../utils/KeepScreenAwakeManager";
import { createPerformanceTracker, type TimingData } from "../utils/PerformanceTracker";
import { type Timer, defaultTimer } from "../utils/SystemTimer";
import {
  deviceReadinessLockKey,
  getDeviceAcquisitionReadiness,
  withDeviceReadinessLock,
} from "../utils/deviceReadinessLock";
import { runWithAbortSignal } from "../utils/AbortContext";
import { serverConfig } from "../utils/ServerConfig";
import type { DeviceReadinessLevel } from "../utils/DeviceSessionManager";

/**
 * Storage for accessibility service setup timing.
 * Keyed by deviceId, consumed once when observe reads it.
 */
const pendingSetupTimings = new Map<string, TimingData>();

/**
 * Store setup timing for a device.
 * Called after accessibility service setup completes.
 */
export function storeSetupTiming(deviceId: string, timing: TimingData): void {
  pendingSetupTimings.set(deviceId, timing);
  logger.info(`[ToolExecutionContext] Stored setup timing for deviceId=${deviceId}`);
}

/**
 * Get and consume the setup timing for a device.
 * Returns the timing data if present and clears it from storage.
 */
export function consumeSetupTiming(deviceId: string): TimingData | null {
  const timing = pendingSetupTimings.get(deviceId);
  const availableKeys = Array.from(pendingSetupTimings.keys());
  if (timing) {
    pendingSetupTimings.delete(deviceId);
    logger.info(`[ToolExecutionContext] Consumed setup timing for deviceId=${deviceId}`);
    return timing;
  }
  if (availableKeys.length > 0) {
    logger.warn(
      `[ToolExecutionContext] No setup timing for deviceId=${deviceId}, available keys: ${availableKeys.join(", ")}`,
    );
  }
  return null;
}

/**
 * Tool Execution Context
 *
 * Provides session and device context to tools executing within the daemon.
 * Enables tools to:
 * - Access assigned device for session
 * - Update session cache after execution
 * - Share state across tool calls within same session
 */
interface ToolExecutionContext {
  sessionId?: string;
  deviceId?: string;
  devicePlatform?: Platform;
  sessionManager?: SessionManager;
  devicePool?: DevicePool;
}

export interface SessionOptions {
  keepScreenAwake?: boolean;
  platform?: Platform;
  /**
   * `booted` skips automation-only setup (accessibility-service / CtrlProxy
   * preparation) for a tool that only needs the device connected and booted.
   * `automationReady` (the default when omitted) performs full setup, matching
   * the historical unconditional behavior. Mirrors
   * {@link DeviceReadinessLevel} so both the fresh-session (legacy) and
   * persisted daemon-session paths honor a tool's declared `deviceReadiness`
   * (#6227).
   */
  deviceReadiness?: DeviceReadinessLevel;
}

/**
 * Create tool execution context from session UUID
 *
 * Ensures session exists and device is assigned if session UUID provided.
 */
export async function createToolExecutionContext(
  sessionUuid: string | undefined,
  sessionManager: SessionManager,
  devicePool: DevicePool,
  sessionOptions: SessionOptions = {},
  execution?: SessionExecutionMetadata,
  admittedSession?: Session,
  // #6069: set by the device-tool path so the getOrCreateSession fallback below
  // cannot mint a brand-new pooled session for a never-issued sessionUuid. Only a
  // live session (resolved via admittedSession / getSessionForNewExecution) or a
  // persisted, non-terminal row (restart recovery) is admissible. Internal callers
  // that intentionally mint fresh derived sessions (device labels) leave it false.
  requireIssuedSession = false,
  signal?: AbortSignal,
): Promise<ToolExecutionContext> {
  if (!sessionUuid) {
    return {};
  }

  if (admittedSession && !sessionManager.isAdmittedForAutomation(admittedSession)) {
    throw new ActionableError(`Session ${sessionUuid} was released during setup`);
  }
  devicePool.assertSessionReadyForAutomation(sessionUuid);
  const existingSession =
    admittedSession ?? sessionManager.getSessionForNewExecution(sessionUuid, execution);

  // Get or create session
  const session =
    admittedSession ??
    (await sessionManager.getOrCreateSession(
      sessionUuid,
      devicePool,
      sessionOptions.platform,
      execution,
      requireIssuedSession,
    ));

  if (!sessionManager.isAdmittedForAutomation(session)) {
    throw new ActionableError(`Session ${sessionUuid} was released during setup`);
  }

  // Acquisition readiness can include an ANR recovery rebind, and that rebind
  // drains tracked session setup before it records the replacement's achieved
  // readiness. Waiting for its marker *inside* trackSessionSetup therefore
  // forms a cycle. Keep marker-only waits outside the tracked mutation and
  // retry if a new acquisition begins while setup is being admitted.
  do {
    await awaitPendingDeviceAcquisitionReadiness(session, signal);
    await awaitReadinessWork(
      sessionManager.trackSessionSetup(session, () =>
        runWithAbortSignal(signal, () =>
          setupSession(
            session,
            existingSession === session,
            sessionManager,
            sessionOptions,
            signal,
          ),
        ),
      ),
      signal,
    );
  } while (await awaitPendingDeviceAcquisitionReadiness(session, signal));
  ensureSessionIsCurrent(session, sessionManager);

  return {
    sessionId: sessionUuid,
    deviceId: session.assignedDevice,
    devicePlatform: session.platform,
    sessionManager,
    devicePool,
  };
}

async function awaitPendingDeviceAcquisitionReadiness(
  session: Session,
  signal?: AbortSignal,
): Promise<boolean> {
  const acquisitionInFlight = getDeviceAcquisitionReadiness(
    deviceReadinessLockKey(session.platform, session.assignedDevice),
  );
  if (!acquisitionInFlight) {
    return false;
  }
  await awaitReadinessWork(acquisitionInFlight, signal);
  return true;
}

function isReadinessSatisfied(
  achieved: DeviceReadinessLevel | undefined,
  required: DeviceReadinessLevel,
): boolean {
  // #6227 P1 follow-up: `undefined` must NOT be treated as satisfied here.
  // A recovered/newly-published session becomes visible to a concurrent
  // `getSessionForNewExecution` lookup (`this.sessions.set(...)` in
  // `persistAndPublishSession`) *before* this module's own setup path gets a
  // chance to call `setDeviceReadiness` (setup runs later, inside
  // `setupSession` -> `runDeviceReadinessSetup`, after `getOrCreateSession`
  // has already returned). A concurrent call that lands in that window would
  // see the session as "existing" with `achieved === undefined` and — if we
  // treated that as satisfied — skip CtrlProxy/accessibility-service setup
  // entirely, running automation against an unprepared device.
  //
  // Treating `undefined` as NOT satisfied closes that hole: the
  // `existingSession` branch below always runs `runDeviceReadinessSetup` for
  // a session whose readiness has never been recorded, which is safe because
  // that setup is idempotent (redundant concurrent runs are harmless, merely
  // wasteful). Callers that track a session directly (e.g.
  // `SessionManager.createSession` in tests) and want to skip this module's
  // setup must record an explicit readiness level via `setDeviceReadiness`
  // rather than relying on `undefined` meaning "already satisfied".
  if (achieved === undefined) {
    return false;
  }
  // `booted` is satisfied by either recorded level; `automationReady` needs
  // the higher level to have actually been achieved.
  return required === "booted" || achieved === "automationReady";
}

/**
 * Per-session in-flight readiness setup (#6227 P1 follow-ups: single-flight).
 *
 * A recovered/newly-published session can be observed by two concurrent
 * `automationReady` calls (e.g. reaching the daemon through different
 * queues) before either has recorded a readiness level. Without
 * serialization both calls would see the same insufficient
 * `getDeviceReadiness` result and both invoke `runDeviceReadinessSetup`,
 * which calls `AndroidCtrlProxyManager.resetSetupState()` on the *shared*
 * per-device manager — the second caller's reset can land mid-setup for the
 * first, corrupting both. Having a concurrent caller await the same
 * in-flight promise (rather than starting its own) closes that race; each
 * waiter re-checks the achieved readiness once the in-flight setup settles,
 * upgrading further only if still insufficient.
 *
 * This map is shared by BOTH the fresh-session setup path (`setupSession`'s
 * `!existingSession` branch) and the existing-session upgrade path
 * (`ensureReadinessUpgraded`). A second P1 follow-up closed a further race:
 * two post-restart calls racing for the same recovered UUID can each compute
 * `existingSession` before the session is published, then one takes the
 * fresh path and the other the existing-session path — if only the upgrade
 * path went through this map, the fresh-path call would run
 * `runDeviceReadinessSetup` directly and unguarded, concurrently with a
 * guarded upgrade for the very same session. Routing the fresh path through
 * `ensureReadinessUpgraded` too (keyed by the same session incarnation)
 * ensures any concurrent caller — fresh or existing — for that session joins
 * the one in-flight setup instead of starting a second.
 *
 * Keyed by the `Session` object itself (its incarnation), NOT by the bare
 * session UUID (#6227 P2 follow-up). `SessionManager` creates a brand-new
 * `Session` object per incarnation (`createSession` / restart recovery), and
 * a session's `cacheData` — where `getDeviceReadiness` reads from — lives on
 * that object, so a replacement incarnation with the same UUID always starts
 * with a clean readiness slate. Keying this map by the bare UUID string
 * would break that isolation: if a nonterminal release reaches its ~1s
 * setup-drain timeout while the old incarnation's setup is still pending and
 * the same UUID is then recreated (possibly bound to a different device),
 * the replacement would find the *predecessor's* promise still registered
 * under that UUID and join it — waiting on, and possibly resolving to, a
 * flight that belongs to a session that no longer exists. A `WeakMap` keyed
 * by the `Session` object scopes each flight to its own incarnation for
 * free: a replacement session is a distinct object, so it can only ever see
 * its own flights, and the predecessor's entry becomes eligible for GC once
 * nothing else references that stale `Session`.
 */
interface ReadinessUpgradeFlight {
  controller: AbortController;
  work: Promise<void>;
  settled: boolean;
  waiters: number;
}

const readinessUpgradeInFlight = new WeakMap<Session, ReadinessUpgradeFlight>();

async function ensureReadinessUpgraded(
  session: Session,
  sessionManager: SessionManager,
  requiredReadiness: DeviceReadinessLevel,
  signal?: AbortSignal,
): Promise<void> {
  for (;;) {
    signal?.throwIfAborted();
    if (
      isReadinessSatisfied(sessionManager.getDeviceReadiness(session.sessionId), requiredReadiness)
    ) {
      return;
    }

    if (requiredReadiness === "booted") {
      // #6227 P1 follow-up: by the time we get here,
      // `devicePool.assertSessionReadyForAutomation` has already confirmed
      // the device itself is booted — a `booted`-only caller (e.g.
      // `listApps`) needs nothing further that a stricter, possibly
      // in-flight `automationReady` setup provides. Joining that flight
      // below would make the `booted` call wait on, and fail from,
      // automation setup (CtrlProxy / accessibility-service) it was
      // specifically routed around. Record the booted baseline directly
      // instead of consulting/joining `readinessUpgradeInFlight` — this
      // executes synchronously up to (and including) the
      // `setDeviceReadiness` write, so it can't race a concurrent
      // automationReady flight's own write.
      await runDeviceReadinessSetup(session, sessionManager, "booted", signal);
      return;
    }

    const inFlight = readinessUpgradeInFlight.get(session);
    if (inFlight) {
      // A flight whose final subscriber already left is being cancelled. A
      // later caller must not inherit that unrelated cancellation; wait for
      // its cleanup to settle, then establish or join a fresh flight.
      if (inFlight.controller.signal.aborted) {
        await inFlight.work.catch(() => undefined);
        continue;
      }
      // Another caller is already upgrading this session's readiness — wait
      // for it rather than racing a second `runDeviceReadinessSetup` call,
      // then loop back to re-check whether it reached the level we need.
      await awaitReadinessFlight(inFlight, signal);
      continue;
    }

    const controller = new AbortController();
    let flight!: ReadinessUpgradeFlight;
    const work = runDeviceReadinessSetup(
      session,
      sessionManager,
      requiredReadiness,
      controller.signal,
    ).finally(() => {
      flight.settled = true;
      if (readinessUpgradeInFlight.get(session) === flight) {
        readinessUpgradeInFlight.delete(session);
      }
    });
    flight = { controller, work, settled: false, waiters: 0 };
    readinessUpgradeInFlight.set(session, flight);
    await awaitReadinessFlight(flight, signal);
    return;
  }
}

/**
 * A request may stop waiting for shared readiness work without cancelling a
 * still-interested joiner. If every subscriber leaves, stop the background
 * setup instead of continuing a cancelled request's device mutation.
 */
async function awaitReadinessFlight(
  flight: ReadinessUpgradeFlight,
  signal?: AbortSignal,
): Promise<void> {
  flight.waiters += 1;
  try {
    await awaitReadinessWork(flight.work, signal);
  } finally {
    flight.waiters -= 1;
    if (flight.waiters === 0 && !flight.settled && !flight.controller.signal.aborted) {
      flight.controller.abort(signal?.reason);
    }
  }
}

async function setupSession(
  session: Session,
  existingSession: boolean,
  sessionManager: SessionManager,
  sessionOptions: SessionOptions,
  signal?: AbortSignal,
): Promise<void> {
  await ensureKeepScreenAwake(session, sessionManager, sessionOptions);
  const requiredReadiness: DeviceReadinessLevel =
    sessionOptions.deviceReadiness ?? "automationReady";

  if (existingSession) {
    // #6227: `existingSession` only means this call reused an already-tracked
    // session — it says nothing about which readiness level that session's
    // prior setup actually reached. A session first touched by a `booted`
    // tool leaves CtrlProxy/accessibility-service setup unprepared; a later
    // call on the same UUID that needs `automationReady` must run that setup
    // now rather than trusting the fast path and returning early against a
    // disconnected/unprepared device. `ensureReadinessUpgraded` serializes
    // concurrent upgrades for the same session (single-flight, #6227 P1
    // follow-up) so two racing callers can't both trigger setup.
    await ensureReadinessUpgraded(session, sessionManager, requiredReadiness, signal);
    return;
  }

  ensureSessionIsCurrent(session, sessionManager);
  // #6227 P1 follow-up: route the fresh-session setup through the same
  // single-flight map used by the existing-session upgrade path (keyed by
  // this session's own incarnation, #6227 P2 follow-up) so a concurrent
  // caller racing for the same recovered session — whether it takes the
  // fresh or existing-session path — joins the one in-flight setup instead
  // of starting a second.
  await ensureReadinessUpgraded(session, sessionManager, requiredReadiness, signal);
  ensureSessionIsCurrent(session, sessionManager);

  // Start test coverage session for navigation graph tracking
  // This enables automatic tracking of screens and transitions during test execution
  const navManager = NavigationGraphManager.getInstanceForSession(session.sessionId);
  if (navManager.getCurrentAppId()) {
    ensureSessionIsCurrent(session, sessionManager);
    await navManager.startTestSession(session.sessionId);
    ensureSessionIsCurrent(session, sessionManager);
    logger.info(
      `[ToolExecutionContext] Started test coverage tracking for session ${session.sessionId}`,
    );
  }
}

/**
 * Run the automation-only setup (CtrlProxy / accessibility service) needed to
 * reach `requiredReadiness` for `session`, then record the achieved level
 * (#6227). Only android needs the extra setup for `automationReady`; every
 * other case is a no-op setup that still records the level so a later
 * `existingSession` call can compare against it.
 */
async function runDeviceReadinessSetup(
  session: Session,
  sessionManager: SessionManager,
  requiredReadiness: DeviceReadinessLevel,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  if (session.platform === "android" && requiredReadiness !== "booted") {
    // #6227 P1 follow-up: serialize this session-scoped upgrade against the
    // SAME per-device readiness lock the acquisition paths
    // (startDevice/getAndroid/provision, via `RunnerReadinessService`) hold
    // while preparing a device. The per-session single-flight above
    // (`readinessUpgradeInFlight`) only stops two upgrades for the *same
    // session* from colliding; without this per-DEVICE lock an upgrade and a
    // concurrent device preparation could both run `resetSetupState()` +
    // `setup()` on the shared per-device `AndroidCtrlProxyManager` singleton.
    // Both paths derive the key via `deviceReadinessLockKey`, so they queue on
    // one lock and setup on a device is never run concurrently.
    await withDeviceReadinessLock(
      deviceReadinessLockKey(session.platform, session.assignedDevice),
      () =>
        runWithAbortSignal(signal, () =>
          ensureAccessibilityServiceReady(
            session.assignedDevice,
            session.sessionId,
            session.platform,
            defaultTimer,
            signal,
          ),
        ),
      { signal },
    );
  }
  ensureSessionIsCurrent(session, sessionManager);
  sessionManager.setDeviceReadiness(session.sessionId, requiredReadiness);
}

/** Await shared readiness work without making a cancelled request wait for it. */
function awaitReadinessWork<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return work;
  }
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void work.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function ensureSessionIsCurrent(session: Session, sessionManager: SessionManager): void {
  if (!sessionManager.isAdmittedForAutomation(session)) {
    throw new ActionableError(`Session ${session.sessionId} was released during setup`);
  }
}

const A11Y_TRANSIENT_ERROR_PATTERNS = [
  "Operation aborted",
  "Operation cancelled",
  "Command timed out",
];

function isTransientA11yError(error: string): boolean {
  return A11Y_TRANSIENT_ERROR_PATTERNS.some((p) => error.includes(p));
}

/**
 * #6227 P1 follow-up: honor `--skip-ctrl-proxy-download` on the session-scoped
 * readiness upgrade exactly as the fresh acquisition path does
 * (`RunnerReadinessService.ensureAndroidReadyWithoutDownloads`). When downloads
 * are disabled and the CtrlProxy artifact is not already installed, the fresh
 * path refuses with an actionable error rather than downloading — an upgrade of
 * a booted-only session must degrade the same way instead of triggering
 * `setup()`'s download/install of a missing artifact.
 */
async function assertCtrlProxyInstalledWhenDownloadsDisabled(
  device: BootedDevice,
  sessionId: string,
): Promise<void> {
  if (!serverConfig.isSkipCtrlProxyDownloadEnabled()) {
    return;
  }
  const driver = getDeviceReadinessProxyDriver(device);
  const installed = await driver.isInstalled();
  if (!installed) {
    throw new ActionableError(
      `Failed to setup accessibility service for device ${device.deviceId} (session ${sessionId}): ` +
        `CtrlProxy is not installed and runner downloads are disabled`,
    );
  }
  // Downloads disabled cannot upgrade an incompatible installed proxy, so an
  // installed-but-incompatible CtrlProxy must be rejected here rather than
  // proceeding to `setup()` against it — matching the fresh acquisition path
  // (`RunnerReadinessService.ensureAndroidReadyWithoutDownloads`).
  const compatible = await driver.isVersionCompatible();
  if (!compatible) {
    throw new ActionableError(
      `Failed to setup accessibility service for device ${device.deviceId} (session ${sessionId}): ` +
        `CtrlProxy version mismatch; run without skipCtrlProxyDownload to install a compatible version`,
    );
  }
}

async function ensureAccessibilityServiceReady(
  deviceId: string,
  sessionId: string,
  platform: Platform,
  timer: Timer = defaultTimer,
  signal?: AbortSignal,
): Promise<void> {
  const device: BootedDevice = {
    name: deviceId,
    platform,
    deviceId,
  };
  logger.info(
    `[ToolExecutionContext] Ensuring accessibility service is ready for session ${sessionId}`,
  );

  await assertCtrlProxyInstalledWhenDownloadsDisabled(device, sessionId);

  const MAX_ATTEMPTS = 2;
  const RETRY_DELAY_MS = 3000;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    signal?.throwIfAborted();
    const perf = createPerformanceTracker(true);
    perf.serial("ensureAccessibilityServiceReady");

    const readinessDriver = getDeviceReadinessProxyDriver(device);
    readinessDriver.resetSetupState();
    const setupResult = await readinessDriver.setup(false, perf);

    if (!setupResult.success) {
      perf.end();
      const timings = perf.getTimings();
      if (timings) {
        logger.info(`[ToolExecutionContext] Accessibility service setup failed`, {
          perfTiming: JSON.stringify(timings, null, 2),
        });
      }

      const errorMsg = setupResult.error || setupResult.message || "";
      if (attempt < MAX_ATTEMPTS && isTransientA11yError(errorMsg)) {
        logger.warn(
          `[A11yRetry] Transient failure on attempt ${attempt}/${MAX_ATTEMPTS}, retrying in ${RETRY_DELAY_MS}ms: ${errorMsg}`,
        );
        await awaitReadinessWork(timer.sleep(RETRY_DELAY_MS), signal);
        continue;
      }

      throw new ActionableError(
        `Failed to setup accessibility service for device ${deviceId} (session ${sessionId}): ${errorMsg}`,
      );
    }

    if (attempt > 1) {
      logger.info(`[A11yRetry] Setup succeeded on attempt ${attempt}/${MAX_ATTEMPTS}`);
    }

    const connected = await perf.track("waitForConnection", () =>
      awaitReadinessWork(readinessDriver.waitForConnection(), signal),
    );

    perf.end();
    const timings = perf.getTimings();
    if (timings) {
      storeSetupTiming(deviceId, timings);
      logger.info(`[ToolExecutionContext] Accessibility service ready for session ${sessionId}`, {
        connected,
      });
    } else {
      logger.warn(
        `[ToolExecutionContext] No timing data captured for setup (deviceId=${deviceId})`,
      );
    }
    return;
  }
}

async function ensureKeepScreenAwake(
  session: Session,
  sessionManager: SessionManager,
  sessionOptions: SessionOptions,
): Promise<void> {
  if (session.platform !== "android") {
    return;
  }
  const existingState = session.cacheData.keepScreenAwake;
  if (existingState) {
    return;
  }

  const keepScreenAwake = sessionOptions.keepScreenAwake !== false;
  const device: BootedDevice = {
    name: session.assignedDevice,
    platform: session.platform,
    deviceId: session.assignedDevice,
  };
  const manager = new KeepScreenAwakeManager(device);

  let state: KeepScreenAwakeState;
  try {
    state = await manager.apply(keepScreenAwake);
  } catch (error) {
    logger.warn(
      `[ToolExecutionContext] Failed to apply keep-awake for ${device.deviceId}: ${error}`,
    );
    state = { applied: false, skipReason: "failed" };
  }

  if (!sessionManager.isAdmittedForAutomation(session)) {
    if (state.applied) {
      try {
        await manager.restore(state);
      } catch (error) {
        logger.warn(
          `[ToolExecutionContext] Failed to restore keep-awake after session release for ${device.deviceId}: ${error}`,
        );
      }
    }
    throw new ActionableError(`Session ${session.sessionId} was released during setup`);
  }

  sessionManager.setKeepScreenAwake(session.sessionId, state);
}
