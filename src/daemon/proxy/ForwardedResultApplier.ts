import type { Timer } from "../../utils/SystemTimer";
import { isCreateTaskResult } from "../tasks/mcpTasksExtension";
import type { TaskRelayFrame } from "../tasks/taskRelay";
import type { ForwardedResultContext, ForwardedToolCall } from "./ToolCallForwarder";
import type { ReleaseEpochLedger } from "./ReleaseEpochLedger";
import type { SessionBinding } from "./SessionBinding";
import { TaskSessionBindings } from "./TaskSessionBindings";

/** What applying a forwarded result needs from the proxy that is not session binding itself. */
export interface ForwardedResultApplierPort {
  creditRoutedSession(result: unknown, forwardedSessionUuid: string | undefined): void;
  rememberToolSelectionProfile(
    name: string,
    callerArgs: Record<string, unknown>,
    result: unknown,
  ): void;
  rememberActiveDeviceSession(
    name: string,
    callerArgs: Record<string, unknown>,
    result: unknown,
    callReleaseEpoch: number,
  ): void;
  noteSuspectSessionResult(
    name: string,
    result: unknown,
    forwardedArgs: Record<string, unknown>,
    allowRetry: boolean,
  ): ForwardedToolCall["retryableSuspectRefusal"];
  noteReleaseSurfacedBy(answer: unknown): void;
  isDeviceBindingTool(name: string): boolean;
}

export interface ForwardedResultApplierDependencies {
  timer: Timer;
  releaseLedger: Pick<
    ReleaseEpochLedger,
    "retainAcquisitionReleaseEpoch" | "releaseAcquisitionReleaseEpoch"
  >;
  sessionBinding: Pick<
    SessionBinding,
    | "bindResultMintedDeviceSession"
    | "namesForeignOwnedSession"
    | "rememberSessionUuid"
    | "bindForwardedSessionOnErrorResult"
  >;
  port: ForwardedResultApplierPort;
}

/**
 * Applies a forwarded call's result to the proxy's session state, whether the result is the
 * call's answer or a device-binding task's completed result (#4668). Moved verbatim from
 * DaemonMcpProxy; behaviour is unchanged.
 */
export class ForwardedResultApplier {
  private tasks: TaskSessionBindings<ForwardedResultContext> | undefined;
  private tasksAbandoned = false;

  constructor(private readonly deps: ForwardedResultApplierDependencies) {}

  /** The device-binding task bindings, once a task has been deferred or relayed. */
  get deviceBindingTasks(): TaskSessionBindings<ForwardedResultContext> | undefined {
    return this.tasks;
  }

  /** Whether the proxy abandoned waiting device-binding tasks while closing. */
  get deviceBindingTasksAbandoned(): boolean {
    return this.tasksAbandoned;
  }

  /**
   * Apply a forwarded call's result to this proxy's session state: credit the routed session, bind
   * a session the result minted or selected, and remember the forwarded one. The one binding
   * implementation, whether the result is the call's answer or a device-binding task's completed
   * result (#4668).
   */
  applyForwardedResult(
    context: ForwardedResultContext,
    result: any,
  ): ForwardedToolCall | Promise<ForwardedToolCall> {
    const { name, callerArgs, forwardedArgs, forwardedSessionUuid, callReleaseEpoch } = context;
    const { port, sessionBinding } = this.deps;
    port.creditRoutedSession(result, forwardedSessionUuid);
    if (result?.isError) {
      // Provisioning retains its usable device session when optional resource
      // configuration fails. Own that result-minted session before returning
      // the evidence-bearing error, so the caller can inspect or retry it.
      return name === "provisionDevice"
        ? sessionBinding
            .bindResultMintedDeviceSession(name, result, callReleaseEpoch)
            .then(() => this.applyForwardedErrorResult(context, result))
        : this.applyForwardedErrorResult(context, result);
    }
    port.rememberToolSelectionProfile(name, callerArgs, result);
    if (context.isSessionAcquisition) {
      return sessionBinding
        .bindResultMintedDeviceSession(name, result, callReleaseEpoch)
        .then(() => ({ result, forwardedSessionUuid }));
    }
    // Remember what was actually forwarded, not the caller's raw args. An
    // implicit sessionless call injects the bound UUID into forwardedArgs and
    // extends the live daemon session in getOrCreateSession(); refreshing the
    // replay lease off forwardedArgs keeps continuous implicit activity from
    // being mistaken for idleness, so a later reconnect re-seeds the still-live
    // session instead of creating an unseeded transport (issue #4610).
    if (!sessionBinding.namesForeignOwnedSession(forwardedArgs, result)) {
      sessionBinding.rememberSessionUuid(name, forwardedArgs, callReleaseEpoch, false);
    }
    port.rememberActiveDeviceSession(name, callerArgs, result, callReleaseEpoch);
    return { result, forwardedSessionUuid };
  }

  private applyForwardedErrorResult(
    context: ForwardedResultContext,
    result: any,
  ): ForwardedToolCall {
    const { name, forwardedArgs, forwardedSessionUuid, callReleaseEpoch } = context;
    const { port, sessionBinding } = this.deps;
    const retryableSuspectRefusal = port.noteSuspectSessionResult(
      name,
      result,
      forwardedArgs,
      context.allowSuspectRetry,
    );
    sessionBinding.bindForwardedSessionOnErrorResult(name, forwardedArgs, result, callReleaseEpoch);
    // The daemon's own terminal refusal (a cut call's answer included) told this caller.
    port.noteReleaseSurfacedBy(result);
    return { result, forwardedSessionUuid, retryableSuspectRefusal };
  }

  /**
   * The device-binding calls the daemon answered with a task (#4668). The first `tasks/get` that
   * reports one `completed` applies the binding the synchronous call would have applied from that
   * result, through the same {@link applyForwardedResult}, exactly once; a failed or cancelled task
   * binds nothing. Each waiting task keeps its call's acquisition release epoch, so a session the
   * daemon released before the poll is not resurrected.
   */
  taskBindings(): TaskSessionBindings<ForwardedResultContext> {
    const { releaseLedger, port, timer } = this.deps;
    this.tasks ??= new TaskSessionBindings<ForwardedResultContext>({
      timer,
      bind: async (context, result) => {
        try {
          await this.applyForwardedResult(context, result);
        } catch (error) {
          port.noteReleaseSurfacedBy(error);
          throw error;
        }
      },
      abandon: () => {
        this.tasksAbandoned = true;
      },
      retain: ({ learnsResultSession, callReleaseEpoch }) =>
        releaseLedger.retainAcquisitionReleaseEpoch(learnsResultSession, callReleaseEpoch),
      release: ({ learnsResultSession, callReleaseEpoch }) =>
        releaseLedger.releaseAcquisitionReleaseEpoch(learnsResultSession, callReleaseEpoch),
    });
    return this.tasks;
  }

  /**
   * Defer a device-binding call's result handling when the daemon ran it as a task (#4668): the
   * handle carries no session, so nothing is bound until a `tasks/get` reports the result. A
   * task's result cannot be forwarded again, so no suspect refusal in it is retried.
   */
  deferredToTask(
    tasks: TaskRelayFrame | undefined,
    result: unknown,
    context: ForwardedResultContext,
  ): boolean {
    const deferred =
      tasks && isCreateTaskResult(result) && this.deps.port.isDeviceBindingTool(context.name);
    if (deferred) {
      this.taskBindings().defer(result.taskId, { ...context, allowSuspectRetry: false });
    }
    return deferred === true;
  }
}
