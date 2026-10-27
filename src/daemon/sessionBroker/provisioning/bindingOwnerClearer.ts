import { errorMessage } from "../../../utils/describeUnknownError";
import type { Timer } from "../../../utils/SystemTimer";
import type {
  BindingExecOwner,
  BindingExecOwnerLiveness,
  BindingKey,
  BindingRegistry,
} from "../registry/bindingRegistry";
import type { RegistryStepRetrier } from "./registryStepRetrier";

/** The registry slice the owner clear needs. */
export type OwnerClearRegistry = Pick<BindingRegistry, "getAssignment" | "releaseExecution">;

/** What {@link BindingOwnerClearer} reads from the drain that owns it. */
export interface BindingOwnerClearerContext {
  timer: Timer;
  retrier: RegistryStepRetrier;
  isExecOwnerLive: BindingExecOwnerLiveness;
  isSessionLive(sessionId: string): boolean;
  isClosed(): boolean;
  /** Warns, unless the drain has closed. */
  warn(message: string, error?: unknown): void;
  /** Keeps a background task alive until it ends. */
  track(task: Promise<void>): void;
  settlementCapMs: number;
  settlementPollMs: number;
}

/** Clears the execution owner records a released session left on its bindings (#11545). */
export class BindingOwnerClearer {
  /** Failed owner clears being retried, one per binding and session ({@link retry}). */
  private readonly inFlight = new Set<string>();

  constructor(private readonly ctx: BindingOwnerClearerContext) {}

  /**
   * The owner record still on a settled binding at its marked binding (#11545). A `settling` binding
   * accepts no claim, so the record predates the mark: it is the released session's own, left by
   * an owner clear that failed (a busy registry). Dead by liveness, the clear is retried and the
   * binding may return to `ready` either way, where a dead record pins nothing (#11339). A live owner
   * is never cleared. Resolves to whether the binding may be restored.
   */
  async clearLeftover(
    registry: OwnerClearRegistry,
    key: BindingKey,
    owner: BindingExecOwner | null,
  ): Promise<boolean> {
    if (owner === null) {
      return true;
    }
    if (this.ctx.isExecOwnerLive(owner)) {
      return false;
    }
    try {
      await registry.releaseExecution(key, owner.sessionUuid);
    } catch (error) {
      this.ctx.warn(
        `[BrokerExecutionRelease] Retrying the owner clear of binding ${key.scopeKey}/` +
          `${key.bindingIndex} for ended session ${owner.sessionUuid} failed; the binding still ` +
          `returns to ready and the clear is retried: ${errorMessage(error)}`,
        error,
      );
      this.ctx.track(this.retry(registry, key, owner.sessionUuid));
    }
    return true;
  }

  /**
   * Retry an owner clear that threw until it lands (#11545). The record it left names this
   * running process: this daemon reads it dead by its ended session, but every other daemon on
   * the host reads it live by process and answers `binding_in_use` for as long as this one runs, so
   * one busy write would pin the binding to them. The first retry waits one poll (the registry was
   * busy a moment ago); a registry step that throws is retried like every other step of the
   * drain, past the settlement cap at the slow cadence, and stops when this daemon closes.
   *
   * Only the ended session's own dead record is cleared. A record that is gone or names another
   * session ends the retry. One that reads live (this daemon holds the session id again, or a
   * drain still holds it) is re-checked at the fast cadence until the settlement cap and then
   * left to that holder, whose own release clears it.
   */
  async retry(registry: OwnerClearRegistry, key: BindingKey, sessionId: string): Promise<void> {
    const id = `${key.scopeKey}/${key.bindingIndex}/${sessionId}`;
    if (this.ctx.isClosed() || this.inFlight.has(id)) {
      return;
    }
    this.inFlight.add(id);
    const { timer } = this.ctx;
    const deadline = timer.now() + this.ctx.settlementCapMs;
    try {
      for (;;) {
        await timer.sleep(this.ctx.settlementPollMs);
        if (this.ctx.isClosed()) {
          return;
        }
        const cleared = await this.ctx.retrier.run(
          `Clearing the owner of binding ${key.scopeKey}/${key.bindingIndex} for ended session ${sessionId}`,
          deadline,
          () => this.clearEndedOnce(registry, key, sessionId),
        );
        if (
          !cleared.done ||
          cleared.value === "done" ||
          timer.now() + this.ctx.settlementPollMs > deadline
        ) {
          return;
        }
      }
    } finally {
      this.inFlight.delete(id);
    }
  }

  /**
   * One attempt of {@link retry}; throws when the registry does. Nothing is awaited
   * between the liveness check and the clear, so a session this daemon comes to hold again is
   * either seen live here or claims the binding after the clear was issued.
   */
  private async clearEndedOnce(
    registry: OwnerClearRegistry,
    key: BindingKey,
    sessionId: string,
  ): Promise<"done" | "owner_live"> {
    const owner = (await registry.getAssignment(key))?.execOwner ?? null;
    // Closed during the read: no write follows; the record dies with this process.
    if (owner === null || owner.sessionUuid !== sessionId || this.ctx.isClosed()) {
      return "done";
    }
    if (this.ctx.isSessionLive(sessionId) || this.ctx.isExecOwnerLive(owner)) {
      return "owner_live";
    }
    await registry.releaseExecution(key, sessionId);
    return "done";
  }
}
