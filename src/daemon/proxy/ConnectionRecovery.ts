import { errorMessage } from "../../utils/describeUnknownError";
import { DaemonShuttingDownError } from "../DaemonShuttingDownError";
import { DaemonBoundSessionLostError } from "../DaemonBoundSessionLostError";
import { logger } from "../../utils/logger";
import { type DaemonClientLike } from "../client";
import { DaemonUnavailableError } from "../client";
import { isRecoverableDaemonReleaseReason } from "../../models/releaseReasons";
import { DaemonBoundSessionExpiredError } from "./DaemonBoundSessionExpiredError";
import { DaemonToolOutcomeUnknownError } from "./DaemonToolOutcomeUnknownError";
import type { SessionReleaseSnapshot } from "../sessionManager/releaseTypes";
import { releaseReasonFromError } from "../types";
import type { DaemonErrorClassifier } from "./DaemonErrorClassifier";

/**
 * What the reconnect-and-retry policy needs from the proxy that owns the connection and the
 * bound-session fences. Narrow on purpose: connection state is read, never written, here.
 */
export interface ConnectionRecoveryPort {
  isClosing(): boolean;
  isConnected(): boolean;
  client(): DaemonClientLike | null;
  isDeadSocket(client: DaemonClientLike): boolean;
  toolCallsInFlight(client: DaemonClientLike): number;
  toolCallsSettled(client: DaemonClientLike): PromiseWithResolvers<void> | undefined;
  setToolCallsSettled(client: DaemonClientLike, settled: PromiseWithResolvers<void>): void;
  daemonShutdownDisconnect(): Promise<void> | null;
  boundSessionUuid(): string | undefined;
  ensureConnected(): Promise<void>;
  resetConnection(): Promise<void>;
  waitForDaemonShutdownDisconnect(): void;
  throwIfBoundSessionFenced(allowReleasedSession?: boolean, namedSessionUuid?: string): void;
  boundSessionExpiredError(): DaemonBoundSessionExpiredError;
  fenceBoundSessionUuid(
    sessionUuid: string,
    reason: string,
    release?: SessionReleaseSnapshot,
  ): void;
  hasRecoverableBoundSessionHandoff(): boolean;
  clearRecoverableBoundSessionHandoff(): void;
  releaseKeepsBinding(sessionUuid: string, releaseReason: string | undefined): boolean;
}

/**
 * Reconnect-and-retry-once policy for a request that failed recoverably (stale session, daemon
 * handoff, dead transport), with the fences that keep a replay from repeating a device action
 * (#6382) and from closing a shared connection under calls in flight (#11656).
 */
export class ConnectionRecovery {
  constructor(
    private readonly port: ConnectionRecoveryPort,
    private readonly errorClassifier: DaemonErrorClassifier,
  ) {}

  async withRecoverableReconnect<T>(
    operation: () => Promise<T>,
    attemptedSessionUuid?: string,
    allowReleasedSession?: boolean,
    fenceSessionNotFoundOnRetry = true,
    nonIdempotentToolName?: string,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<T> {
    signal.throwIfAborted();
    if (this.port.isClosing()) {
      throw new DaemonUnavailableError("MCP proxy is closing");
    }
    this.port.throwIfBoundSessionFenced(allowReleasedSession, attemptedSessionUuid);
    if (this.port.hasRecoverableBoundSessionHandoff()) {
      await this.resetConnectionForRecoverableHandoff();
      // doConnect restarts the heartbeat keeper. Clear the marker before that
      // asynchronous tick can enter withRecoverableReconnect and reset the new
      // transport beneath the operation that is reclaiming this UUID.
      this.port.clearRecoverableBoundSessionHandoff();
    }
    let established = false;

    try {
      // Socket identity discovery can race a daemon handoff before any tool
      // has been dispatched. Give establishment the same single reconnect
      // attempt as a recoverable transport failure, preserving the fences.
      await this.port.ensureConnected();
      signal.throwIfAborted();
      this.port.throwIfBoundSessionFenced(allowReleasedSession, attemptedSessionUuid);
      established = true;
      return await operation();
    } catch (error) {
      signal.throwIfAborted();
      if (this.port.isClosing()) {
        throw error;
      }
      this.port.throwIfBoundSessionFenced(allowReleasedSession, attemptedSessionUuid);
      this.throwIfBoundSessionLost(error);
      this.throwIfSessionEndedAnswer(error, attemptedSessionUuid, fenceSessionNotFoundOnRetry);
      if (!this.errorClassifier.isRecoverableDaemonSessionError(error, established)) {
        throw error;
      }
      if (error instanceof DaemonShuttingDownError) {
        this.port.waitForDaemonShutdownDisconnect();
      }
      const refusedToolName = this.ambiguousReplayToolName(
        error,
        established,
        nonIdempotentToolName,
      );
      if (refusedToolName !== undefined) {
        // The tool may have reached the daemon and run: never re-run it (issue #6382).
        await this.throwOutcomeWithoutReplay(refusedToolName, error);
      }

      await this.resetConnectionForRetry(error);
      signal.throwIfAborted();
      this.port.throwIfBoundSessionFenced(allowReleasedSession, attemptedSessionUuid);
      await this.port.ensureConnected();
      signal.throwIfAborted();
      this.port.throwIfBoundSessionFenced(allowReleasedSession, attemptedSessionUuid);
      try {
        return await operation();
      } catch (retryError) {
        signal.throwIfAborted();
        this.port.throwIfBoundSessionFenced(allowReleasedSession, attemptedSessionUuid);
        const sessionNotFoundFenceTarget = this.sessionNotFoundFenceTarget(
          retryError,
          attemptedSessionUuid,
          fenceSessionNotFoundOnRetry,
        );
        this.throwIfSessionEndedAnswer(
          retryError,
          attemptedSessionUuid,
          fenceSessionNotFoundOnRetry,
        );
        if (sessionNotFoundFenceTarget) {
          this.port.fenceBoundSessionUuid(sessionNotFoundFenceTarget, "session-not-found");
          throw this.port.boundSessionExpiredError();
        }
        await this.throwIfRetryOutcomeUnknown(retryError, nonIdempotentToolName);
        throw retryError;
      }
    }
  }

  /**
   * The latest binding was handed off recoverably (a daemon shutdown or restart, its device's
   * restart): the next request reclaims it on a fresh connection. With tool calls in flight on
   * the connection it is reclaimed on that connection instead
   * ({@link connectionCarriesCallsInFlight}).
   */
  private resetConnectionForRecoverableHandoff(): Promise<void> {
    return this.connectionCarriesCallsInFlight()
      ? Promise.resolve()
      : this.resetConnectionOnceDrained();
  }

  /**
   * Before the one retry of a request that failed recoverably: replace the connection, unless the
   * failure is the daemon's answer about one session on a connection with tool calls in flight
   * ({@link isSessionAnswerOnSharedConnection}), which is asked again where it is. Not `async`:
   * the reset is awaited as directly as before, since callers' scheduling depends on its turns.
   */
  private resetConnectionForRetry(error: unknown): Promise<void> {
    if (this.isSessionAnswerOnSharedConnection(error)) {
      logger.info(
        `[DaemonMcpProxy] Asking once more on the same daemon connection, which has tool calls in flight: ${errorMessage(error)}`,
      );
      return Promise.resolve();
    }
    logger.warn(
      `[DaemonMcpProxy] Daemon session is stale, reconnecting and retrying once: ${errorMessage(error)}`,
    );
    return this.resetConnectionOnceDrained();
  }

  /**
   * The single retry of a non-idempotent tool reached a written frame before the
   * transport failed again: the retried call may have run, so surface the same
   * outcome-unknown error as a first attempt instead of the raw transport error
   * (an agent that sees only "Socket connection closed" would retry the action).
   * A retry that provably never reached the daemon stays a plain not-delivered
   * failure; nothing is retried again either way.
   */
  private async throwIfRetryOutcomeUnknown(
    retryError: unknown,
    nonIdempotentToolName: string | undefined,
  ): Promise<void> {
    if (!this.errorClassifier.isRecoverableDaemonSessionError(retryError, true)) {
      return;
    }
    const refusedToolName = this.ambiguousReplayToolName(retryError, true, nonIdempotentToolName);
    if (refusedToolName === undefined) {
      return;
    }
    await this.throwOutcomeWithoutReplay(refusedToolName, retryError);
  }

  /**
   * End a non-idempotent tool call that may have run, without sending it again (issue #6382).
   * The daemon's own typed `daemon_shutting_down` answer reaches the caller as it was given:
   * typed and retryable, with `requestMayHaveDispatched`, so the caller decides whether to repeat
   * the step. Any other failure says only that the transport died, so the outcome is unknown and
   * the dead connection is replaced for the next call.
   */
  private async throwOutcomeWithoutReplay(toolName: string, error: unknown): Promise<never> {
    if (!(error instanceof DaemonShuttingDownError)) {
      // A not-found answer came over a working connection: there is no dead transport to replace
      // beneath the calls still in flight on it ({@link isSessionAnswerOnSharedConnection}).
      if (!this.isSessionAnswerOnSharedConnection(error)) {
        await this.port.resetConnection();
      }
      throw new DaemonToolOutcomeUnknownError(toolName, error);
    }
    this.port.waitForDaemonShutdownDisconnect();
    if (this.drainingToolCalls() === undefined) {
      await this.port.resetConnection();
    }
    throw error;
  }

  /**
   * The wait a connection-wide reset owes the tool calls still in flight on a connection whose
   * daemon is shutting down; undefined when there is nothing to wait for. A shutdown refusal or a
   * `daemon-shutdown` handoff seen by one request (a keeper heartbeat, a sibling call) says
   * nothing about the others: the daemon answers each of them, with its result or with its own
   * `daemon_shutting_down`, before it closes the socket. Closing the one shared socket first
   * would fail them here, as outcome-unknown, for steps the daemon was about to answer.
   *
   * The wait ends when the last of those calls settles, when the daemon closes the connection, or
   * when the shutdown barrier gives up on a daemon that never closes ({@link
   * waitForDaemonShutdownDisconnect}, which then detaches the connection itself). While it lasts
   * the connection is not reusable, so nothing new is sent on it: every new request waits for
   * the successor connection in {@link ensureConnected}.
   */
  private drainingToolCalls(): Promise<void> | undefined {
    const client = this.port.client();
    const barrier = this.port.daemonShutdownDisconnect();
    if (!client || !barrier || this.port.toolCallsInFlight(client) === 0) {
      return undefined;
    }
    let settled = this.port.toolCallsSettled(client);
    if (!settled) {
      settled = Promise.withResolvers<void>();
      this.port.setToolCallsSettled(client, settled);
    }
    // Whichever comes first: the barrier never rejects, and resolving twice is a no-op.
    const drained = Promise.withResolvers<void>();
    void barrier.then(drained.resolve);
    void settled.promise.then(drained.resolve);
    return drained.promise;
  }

  /**
   * {@link resetConnection}, after the tool calls in flight on a draining connection have their
   * answers ({@link drainingToolCalls}). A connection that was replaced while this waited is
   * someone else's: it is left alone.
   */
  private async resetConnectionOnceDrained(): Promise<void> {
    const draining = this.drainingToolCalls();
    if (draining === undefined) {
      await this.port.resetConnection();
      return;
    }
    const drainedClient = this.port.client();
    await draining;
    if (this.port.client() === drainedClient && !this.port.isClosing()) {
      await this.port.resetConnection();
    }
  }

  /**
   * Whether tool calls are awaiting their answers on the current, working daemon connection. It
   * is the one socket for every session this proxy holds, so closing it cancels each of those
   * calls in the daemon mid-run and answers it outcome-unknown, whichever session it drives
   * (#11656). What happens to ONE session (the daemon answers not-found for it, or hands it off
   * for its device's restart) is therefore never a reason to close it under them: the daemon that
   * answered is the one running those calls, so the session is asked again, or reclaimed, on the
   * connection it shares with them. Nothing waits for those calls, so no heartbeat is held up
   * behind one, and with none in flight the fresh connection costs nobody anything and is still
   * made (it is what reaches a successor daemon).
   *
   * False for a connection that is not in use as it stands: one draining at daemon shutdown, whose
   * reset waits for its calls ({@link drainingToolCalls}), and one a transport failure proved dead,
   * where there is nothing left to lose. What ends a connection as a whole (a transport failure,
   * the daemon's shutdown or close) is not decided here.
   */
  private connectionCarriesCallsInFlight(): boolean {
    const client = this.port.client();
    return (
      client !== null &&
      this.port.isConnected() &&
      !this.port.isDeadSocket(client) &&
      this.port.toolCallsInFlight(client) > 0
    );
  }

  /**
   * The daemon answered a request not-found for its session while other tool calls are in flight
   * on the connection: an answer about that session, which leaves the connection as it is
   * ({@link connectionCarriesCallsInFlight}). The request that was answered has settled, so the
   * calls counted are never its own.
   */
  private isSessionAnswerOnSharedConnection(error: unknown): boolean {
    return (
      this.errorClassifier.isDaemonSessionNotFoundError(error) &&
      this.connectionCarriesCallsInFlight()
    );
  }

  /**
   * A not-found answer that names a release which ends the session (#11520): every reason but a
   * recoverable handoff of a session this proxy owns, classified by {@link releaseKeepsBinding}
   * like the release notification. The daemon answered about that session on a working
   * connection, so nothing is stale: resetting the one shared socket would cut the connection
   * attempt this request may be part of, and every sibling call in flight, to ask a question
   * already answered. An answer with no reason, or with a recoverable one, says nothing final and
   * keeps the reconnect-and-retry, unless it is a heartbeat's first answer on a connection that
   * was just established ({@link askSessionHeartbeat}).
   */
  private sessionEndedAnswerReason(
    error: unknown,
    attemptedSessionUuid: string | undefined,
  ): string | undefined {
    if (!this.errorClassifier.isDaemonSessionNotFoundError(error)) {
      return undefined;
    }
    const releaseReason = releaseReasonFromError(error);
    if (releaseReason === undefined) {
      return undefined;
    }
    const keepsBinding =
      attemptedSessionUuid === undefined
        ? isRecoverableDaemonReleaseReason(releaseReason)
        : this.port.releaseKeepsBinding(attemptedSessionUuid, releaseReason);
    return keepsBinding ? undefined : releaseReason;
  }

  /**
   * Rethrow a not-found answer that ends the session ({@link sessionEndedAnswerReason}) without
   * touching the connection. A caller that fences on not-found gets the binding fenced under the
   * daemon's reason and the terminal refusal; a heartbeat decides its own not-found answers before
   * they get here ({@link noteNotFoundAnswer}).
   */
  private throwIfSessionEndedAnswer(
    error: unknown,
    attemptedSessionUuid: string | undefined,
    fenceSessionNotFound: boolean,
  ): void {
    const releaseReason = this.sessionEndedAnswerReason(error, attemptedSessionUuid);
    if (releaseReason === undefined) {
      return;
    }
    const fenceTarget = this.sessionNotFoundFenceTarget(
      error,
      attemptedSessionUuid,
      fenceSessionNotFound,
    );
    if (fenceTarget) {
      this.port.fenceBoundSessionUuid(fenceTarget, releaseReason);
      throw this.port.boundSessionExpiredError();
    }
    throw error;
  }

  private sessionNotFoundFenceTarget(
    error: unknown,
    attemptedSessionUuid: string | undefined,
    fenceSessionNotFoundOnRetry: boolean,
  ): string | undefined {
    if (
      !fenceSessionNotFoundOnRetry ||
      !attemptedSessionUuid ||
      this.port.boundSessionUuid() !== attemptedSessionUuid ||
      !this.errorClassifier.isDaemonSessionNotFoundError(error)
    ) {
      return undefined;
    }
    return attemptedSessionUuid;
  }

  private throwIfBoundSessionLost(error: unknown): void {
    if (!(error instanceof DaemonBoundSessionLostError)) {
      return;
    }
    if (error.failure.sessionUuid !== this.port.boundSessionUuid()) {
      throw new DaemonBoundSessionExpiredError(
        error.failure.sessionUuid,
        error.failure.reason,
        error.failure.release,
      );
    }
    this.port.fenceBoundSessionUuid(
      error.failure.sessionUuid,
      error.failure.reason,
      error.failure.release,
    );
    throw this.port.boundSessionExpiredError();
  }

  /**
   * The non-idempotent tool whose replay must be refused because nothing proves
   * the failed attempt never dispatched it; undefined when a replay is safe.
   * Before establishment the operation never ran, so a replay is always safe.
   */
  private ambiguousReplayToolName(
    error: unknown,
    established: boolean,
    nonIdempotentToolName: string | undefined,
  ): string | undefined {
    if (!established || this.errorClassifier.isProvablyUndispatchedError(error)) {
      return undefined;
    }
    return nonIdempotentToolName;
  }
}
