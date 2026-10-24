import { ActionableError, toActionableError } from "../../models";
import type { SessionConfig } from "../../devices/sessionConfig";
import {
  type SessionBrokerReleaseReason,
  type SessionBrokerReleaseResult,
  type SessionBrokerResult,
} from "../../devices/sessionBrokerResult";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import type { Timer } from "../../utils/SystemTimer";
import { DaemonUnavailableError, type DaemonClientLike } from "../client";
import { BROKER_EXECUTION_RELEASE_TIMEOUT_MS } from "../sessionBroker/provisioning/executionLiveness";
import {
  acquireSessionThroughDaemon,
  DAEMON_RELEASE_BROKER_SESSION_METHOD,
} from "../sessionBrokerProxyAcquisition";
import { SESSION_OWNERSHIP_LOST_CODE } from "../sessionReleasedDuringCall";
import { DAEMON_REGISTER_SESSION_METHOD } from "../wire/constants";

const SESSION_BROKER_PROXY_CLIENT_NAME = "auto-mobile-session-broker-proxy";
const BROKER_RELEASE_RETRY_DEFAULT_MS = 250;
const BROKER_RELEASE_RETRY_MIN_MS = 50;
const BROKER_RELEASE_RETRY_MAX_MS = 5_000;
const BROKER_RELEASE_RETRY_MIN_CALL_MS = 50;
// Acquisition cleanup can wait one daemon recovery cadence plus a round trip and slack.
const BROKER_PREPARED_RELEASE_TIMEOUT_MS = 7_000;

/** Leave transport headroom even when a final retry has less than 500 ms remaining. */
function releaseReplyBudgetMs(timeoutMs: number): number {
  if (timeoutMs - 500 >= 250) {
    return timeoutMs - 500;
  }
  return Math.max(0, Math.min(250, Math.floor(timeoutMs / 2)));
}

/** Release is idempotent, but only the explicit restart-handoff refusal permits a retry. */
function releaseRetryDelay(value: unknown): number | undefined {
  if (
    value === null ||
    typeof value !== "object" ||
    !("code" in value) ||
    value.code !== "session_restart_handoff_pending" ||
    !("retryable" in value) ||
    value.retryable !== true
  ) {
    return undefined;
  }
  const hint = "retryAfterMs" in value ? value.retryAfterMs : undefined;
  const delay =
    typeof hint === "number" && Number.isFinite(hint) && hint > 0
      ? hint
      : BROKER_RELEASE_RETRY_DEFAULT_MS;
  return Math.min(BROKER_RELEASE_RETRY_MAX_MS, Math.max(BROKER_RELEASE_RETRY_MIN_MS, delay));
}

function isSessionOwnershipLostError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === SESSION_OWNERSHIP_LOST_CODE
  );
}

/**
 * An acquisition-cleanup release in flight. Its retry may sleep a 5 s recovery hint, longer than
 * the shutdown release budget, so close takes it over and the retry joins close's release
 * instead of waking against the closed daemon client (#14490).
 */
interface PreparedRelease {
  takenOver?: Promise<unknown>;
}

/** A ready broker receipt currently held by the heartbeat keeper. */
export interface BrokerBinding {
  requestId: string;
  sessionUuid: string;
}

/**
 * Proxy state and operations the broker session lifecycle reads:
 * - ensureConnected, requireClient and client reach the daemon connection.
 * - isClosing, boundSessionUuid and terminalBoundSessionUuid read the live binding scalars.
 * - bindStartupSession, establishBoundSessionHeartbeat, fenceBoundSession and forgetBoundSession
 *   drive the binding and keeper that stay owned by the proxy.
 */
export interface BrokerSessionsPort {
  ensureConnected(): Promise<void>;
  requireClient(): DaemonClientLike;
  client(): DaemonClientLike | null;
  isClosing(): boolean;
  boundSessionUuid(): string | undefined;
  terminalBoundSessionUuid(): string | undefined;
  bindStartupSession(sessionUuid: string): void;
  establishBoundSessionHeartbeat(): Promise<void>;
  fenceBoundSession(sessionUuid: string, code: string): void;
  /** Drop every proxy-side hold on a broker session that was released or abandoned. */
  forgetBoundSession(sessionUuid: string): void;
}

export interface BrokerSessionsDependencies {
  timer: Timer;
  livenessOwnerToken: string;
  port: BrokerSessionsPort;
}

/**
 * The durable session broker state of one proxy and its acquire/hold/rebind/release lifecycle.
 * Release retries share a caller-specific bounded budget while retaining the local receipt.
 */
export class BrokerSessions {
  /** The durable session broker result exposed by this proxy. */
  private brokerResult: SessionBrokerResult | undefined;
  private binding: BrokerBinding | undefined;
  /** Broker sessions are excluded from generic release until their broker release settles. */
  readonly sessions = new Map<string, string>();
  /** Aborts preparation and same-request status polling when the proxy closes. */
  private acquisitionAbort: AbortController | undefined;
  /** Acquisition-cleanup releases close must cover, even for sessions never held. */
  private readonly preparedReleases = new Map<string, PreparedRelease>();

  constructor(private readonly deps: BrokerSessionsDependencies) {}

  private get port(): BrokerSessionsPort {
    return this.deps.port;
  }

  get result(): SessionBrokerResult | undefined {
    return this.brokerResult;
  }

  /**
   * Prepare one durable broker request before serving MCP. The helper owns bounded same-request
   * status recovery; a ready result is bound, claimed and heartbeated here.
   */
  async acquire(config: SessionConfig): Promise<SessionBrokerResult> {
    const abort = new AbortController();
    this.acquisitionAbort = abort;
    try {
      const result = await acquireSessionThroughDaemon(
        config,
        {
          ensureConnected: () => this.port.ensureConnected(),
          callDaemonMethod: (method, params, options) =>
            this.port.requireClient().callDaemonMethod(method, params, options),
          holdSession: (requestId, sessionUuid) => this.hold(requestId, sessionUuid),
          releaseSession: (sessionUuid) => this.releasePrepared(sessionUuid),
          livenessOwnerToken: this.deps.livenessOwnerToken,
          timer: this.deps.timer,
        },
        abort.signal,
      );
      this.brokerResult = result;
      return result;
    } finally {
      if (this.acquisitionAbort === abort) {
        this.acquisitionAbort = undefined;
      }
    }
  }

  /** Abort preparation and status polling because the proxy is closing. */
  abortAcquisition(reason: unknown): void {
    this.acquisitionAbort?.abort(reason);
  }

  /** Forget every broker hold once the proxy has closed. */
  clear(): void {
    this.sessions.clear();
    this.binding = undefined;
  }

  /** Bind a ready receipt to the existing keeper without enrolling it in broker binding release. */
  async hold(requestId: string, sessionUuid: string): Promise<void> {
    const trimmedRequestId = requestId.trim();
    const trimmedSessionUuid = sessionUuid.trim();
    if (trimmedRequestId.length === 0 || trimmedSessionUuid.length === 0) {
      throw new ActionableError("A session broker request ID and session UUID are required.");
    }
    if (this.port.isClosing()) {
      throw new DaemonUnavailableError("MCP proxy is closing");
    }
    const existing = this.binding;
    if (
      existing &&
      (existing.requestId !== trimmedRequestId || existing.sessionUuid !== trimmedSessionUuid)
    ) {
      throw new ActionableError(
        `Cannot hold broker session ${trimmedSessionUuid}: request ${existing.requestId} already ` +
          `holds session ${existing.sessionUuid}.`,
      );
    }
    const bound = this.port.boundSessionUuid();
    if (bound !== undefined && bound !== trimmedSessionUuid) {
      throw new ActionableError(
        `Cannot hold broker session ${trimmedSessionUuid}: this proxy is already bound to ` +
          `session ${bound}.`,
      );
    }
    this.port.bindStartupSession(trimmedSessionUuid);
    this.sessions.set(trimmedSessionUuid, trimmedRequestId);
    this.binding = {
      requestId: trimmedRequestId,
      sessionUuid: trimmedSessionUuid,
    };
    try {
      await this.port.ensureConnected();
      await this.port.establishBoundSessionHeartbeat();
      this.assertStillHeld(trimmedRequestId, trimmedSessionUuid);
    } catch (error) {
      this.binding = undefined;
      throw toActionableError(error, `Failed to hold broker session ${trimmedSessionUuid}`);
    }
  }

  /** Fence after the awaited claim: close or terminal evidence may have ended this binding (#12770). */
  private assertStillHeld(requestId: string, sessionUuid: string): void {
    const held = this.heldBinding();
    if (
      this.port.isClosing() ||
      held?.requestId !== requestId ||
      held.sessionUuid !== sessionUuid
    ) {
      throw new ActionableError(
        `Broker session ${sessionUuid} was released or fenced while its ownership was being established.`,
      );
    }
  }

  heldBinding(): BrokerBinding | undefined {
    const binding = this.binding;
    if (
      !binding ||
      this.sessions.get(binding.sessionUuid) !== binding.requestId ||
      this.port.boundSessionUuid() !== binding.sessionUuid ||
      this.port.terminalBoundSessionUuid() === binding.sessionUuid
    ) {
      return undefined;
    }
    return binding;
  }

  /** Rebind only the still-current durable receipt; the daemon derives its private scope. */
  async rebindConnection(client: DaemonClientLike): Promise<void> {
    const binding = this.heldBinding();
    if (!binding || this.port.isClosing() || this.port.client() !== client) {
      return;
    }
    try {
      await client.callDaemonMethod(DAEMON_REGISTER_SESSION_METHOD, {
        sessionId: binding.sessionUuid,
        clientName: SESSION_BROKER_PROXY_CLIENT_NAME,
        sessionBroker: {
          requestId: binding.requestId,
          livenessOwnerToken: this.deps.livenessOwnerToken,
        },
      });
    } catch (error) {
      if (isSessionOwnershipLostError(error) && this.isCurrentBinding(binding)) {
        this.binding = undefined;
        this.port.fenceBoundSession(binding.sessionUuid, SESSION_OWNERSHIP_LOST_CODE);
        logger.warn(
          `[DaemonMcpProxy] Broker request ${binding.requestId} no longer grants session ` +
            `${binding.sessionUuid}; the binding is terminal.`,
          error,
        );
        return;
      }
      logger.warn(
        `[DaemonMcpProxy] Re-binding broker request ${binding.requestId} failed: ${errorMessage(error)}`,
        error,
      );
    }
  }

  private isCurrentBinding(binding: BrokerBinding): boolean {
    return (
      this.binding?.requestId === binding.requestId &&
      this.binding.sessionUuid === binding.sessionUuid &&
      this.sessions.get(binding.sessionUuid) === binding.requestId
    );
  }

  private async callRelease(
    sessionUuid: string,
    budgetMs: number,
    reason?: SessionBrokerReleaseReason,
    prepared?: PreparedRelease,
  ): Promise<unknown> {
    const deadline = this.deps.timer.now() + budgetMs;
    while (true) {
      if (prepared?.takenOver) {
        // Close already released this session within its own budget; never resend after it.
        return await prepared.takenOver;
      }
      let result: unknown;
      try {
        result = await this.callReleaseOnce(sessionUuid, reason, deadline - this.deps.timer.now());
      } catch (error) {
        if (!(await this.waitForReleaseRetry(error, deadline))) {
          // Preserve the original failure and its typed hints for acquisition cleanup to report.
          throw error;
        }
        // Restart handoff is transient; the bounded retry keeps the receipt until release settles.
        logger.info(`[DaemonMcpProxy] Retrying broker release for ${sessionUuid}`, error);
        continue;
      }
      if (!(await this.waitForReleaseRetry(result, deadline))) {
        return result;
      }
      logger.info(`[DaemonMcpProxy] Retrying broker release for ${sessionUuid}`);
    }
  }

  private async waitForReleaseRetry(value: unknown, deadline: number): Promise<boolean> {
    const delay = releaseRetryDelay(value);
    const remaining = deadline - this.deps.timer.now();
    if (delay === undefined || remaining - delay < BROKER_RELEASE_RETRY_MIN_CALL_MS) {
      return false;
    }
    // Do not spend the remaining budget sleeping unless a useful release call can follow it.
    await this.deps.timer.sleep(delay);
    return deadline - this.deps.timer.now() >= BROKER_RELEASE_RETRY_MIN_CALL_MS;
  }

  private async callReleaseOnce(
    sessionUuid: string,
    reason: SessionBrokerReleaseReason | undefined,
    timeoutMs: number,
  ): Promise<unknown> {
    const client = this.port.client();
    if (!client) {
      throw new DaemonUnavailableError("Cannot release broker session without a daemon connection");
    }
    return raceWithDeadline(
      () =>
        client.callDaemonMethod(
          DAEMON_RELEASE_BROKER_SESSION_METHOD,
          {
            sessionId: sessionUuid,
            livenessOwnerToken: this.deps.livenessOwnerToken,
            ...(reason ? { reason } : {}),
            replyBudgetMs: releaseReplyBudgetMs(timeoutMs),
          },
          { timeoutMs },
        ),
      {
        timer: this.deps.timer,
        timeoutMs,
        label: `Release broker session ${sessionUuid}`,
      },
    );
  }

  private forget(sessionUuid: string): void {
    const requestId = this.sessions.get(sessionUuid);
    this.sessions.delete(sessionUuid);
    if (
      requestId !== undefined &&
      this.binding?.requestId === requestId &&
      this.binding.sessionUuid === sessionUuid
    ) {
      this.binding = undefined;
    }
    this.port.forgetBoundSession(sessionUuid);
  }

  private async releasePrepared(sessionUuid: string): Promise<unknown> {
    // A late hold must not re-register on reconnect while its release is retrying.
    if (this.binding?.sessionUuid === sessionUuid) {
      this.binding = undefined;
    }
    const prepared: PreparedRelease = {};
    this.preparedReleases.set(sessionUuid, prepared);
    try {
      return await this.callRelease(
        sessionUuid,
        BROKER_PREPARED_RELEASE_TIMEOUT_MS,
        undefined,
        prepared,
      );
    } finally {
      if (this.preparedReleases.get(sessionUuid) === prepared) {
        this.preparedReleases.delete(sessionUuid);
      }
      this.forget(sessionUuid);
    }
  }

  /**
   * Broker teardown remains durable in the daemon even when this bounded call cannot confirm it.
   * An execution-owner loss reports `session_owner_exited` (#12791): the daemon records that
   * terminal receipt and answers before device destruction, which outlasts this bound.
   * An in-flight acquisition-cleanup release is released here too, at once, because the daemon
   * client closes after this returns (#14490).
   */
  async releaseAll(reason?: SessionBrokerReleaseReason): Promise<void> {
    const sessions = new Set([...this.sessions.keys(), ...this.preparedReleases.keys()]);
    this.binding = undefined;
    await Promise.all(
      [...sessions].map(async (sessionUuid) => {
        try {
          const releasing = this.callRelease(
            sessionUuid,
            BROKER_EXECUTION_RELEASE_TIMEOUT_MS,
            reason,
          );
          const prepared = this.preparedReleases.get(sessionUuid);
          if (prepared) {
            prepared.takenOver = releasing;
          }
          const result = await releasing;
          const release = result as Partial<SessionBrokerReleaseResult> | undefined;
          if (
            release?.sessionUuid !== sessionUuid ||
            !["released", "cleanup_pending", "unknown_session"].includes(String(release?.outcome))
          ) {
            logger.warn(
              `[DaemonMcpProxy] Broker release for ${sessionUuid} returned a stale or malformed result`,
            );
          } else if (release.outcome === "unknown_session") {
            logger.warn(
              `[DaemonMcpProxy] Broker release for ${sessionUuid} did not find its durable receipt`,
            );
          } else {
            logger.info(
              `[DaemonMcpProxy] Released broker session ${sessionUuid}: ${release.outcome}`,
            );
          }
        } catch (error) {
          logger.warn(
            `[DaemonMcpProxy] Releasing broker session ${sessionUuid} failed; durable daemon ` +
              `cleanup remains pending: ${errorMessage(error)}`,
            error,
          );
        } finally {
          this.forget(sessionUuid);
        }
      }),
    );
  }
}
