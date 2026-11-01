import { settingsCommand } from "./setupUser";
import { ENV } from "../config/env";
import { readEnvInt } from "../utils/envNumbers";
import {
  defaultHostLoadReader,
  loadScaledBudget,
  retryBudget,
  describeLoadScaledBudget,
  type HostLoadReader,
  type LoadScaledBudget,
} from "../utils/hostLoadBudget";
import { DUMPSYS_MAX_BUFFER } from "../utils/android-cmdline-tools/dumpsysLimits";
import { getAbortSignal, runWithAbortSignal } from "../utils/AbortContext";
import { SingleFlight } from "../utils/cache/SingleFlight";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import { errorMessage } from "../utils/describeUnknownError";
import { toActionableError } from "../models/ActionableError";
import { isAndroidFrameworkUnavailable } from "../utils/android-cmdline-tools/isAndroidFrameworkUnavailable";
import type { AdbExecutor } from "../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { logger } from "../utils/logger";
import { shellQuote } from "../utils/shellQuote";
import { ActionableError, BootedDevice, ExecResult } from "../models";
import { Timer } from "../utils/SystemTimer";
import { CTRL_PROXY_ACCESSIBILITY_SERVICE_COMPONENT, CTRL_PROXY_PACKAGE } from "./constants";
import { CtrlProxyInspectionError } from "./CtrlProxyInspectionError";

// API 36 can take about 6 seconds to bind CtrlProxy after a force-stop; allow
// another 2 seconds for scheduler and adb polling delay before giving up.
export const REBIND_BIND_WAIT_BUDGET_MS = 8_000;
/**
 * Bound on each device write in the rebind's mutating section (remove, force-stop,
 * re-add, restore). Those writes run under a private signal because the caller's
 * request signal may already have aborted, so they need a cap of their own.
 */
export const REBIND_MUTATION_COMMAND_TIMEOUT_MS = 5_000;
type RebindFlightKind = "check" | "force";
interface RebindPlan {
  withoutCtrlProxy: string;
  withCtrlProxy: string;
  /** The user the whole remove, re-add and restore sequence targets, resolved once up front. */
  user: number | undefined;
}
type AccessibilityServiceState = "bound" | "binding" | "crashed" | "absent" | "unbound";

/** Live manager dependencies; callbacks preserve manager overrides and test spies. */
export interface AndroidCtrlProxyRebindHost {
  readonly hostLoad?: HostLoadReader;
  readonly env?: NodeJS.ProcessEnv;
  readonly adb: AdbExecutor;
  readonly timer: Timer;
  assertNotDrivenByOtherDaemon(signal?: AbortSignal): Promise<void>;
  readonly device: BootedDevice;
  isAccessibilityServiceHealthy(): Promise<boolean>;
  clearAvailabilityCache(): void;
  /** The user to set CtrlProxy up for on a headless-system-user device; undefined everywhere else. */
  setupUser(): Promise<number | undefined>;
}

/** Framework binding inspection and cancellation-safe shared recovery. */
export class AndroidCtrlProxyRebind {
  // android:label references accessibility_service_name in control-proxy/strings.xml.
  private static readonly ACCESSIBILITY_SERVICE_LABEL = "AutoMobile CtrlProxy";
  // Let Android release the crashed process's listener before re-enabling it.
  private static readonly REBIND_FORCE_STOP_SETTLE_MS = 100;

  // Poll the framework while it binds the new process.
  private static readonly REBIND_HEALTH_POLL_MS = 200;

  private static readonly REBIND_BIND_GRACE_MS = REBIND_BIND_WAIT_BUDGET_MS;

  private bindingFirstObservedAt: number | null = null;

  // In-flight guard (issue #7532 review): the #7534 readiness path
  // (ToolExecutionContext.ensureAccessibilityServiceReady) and a client's own
  // connection-failure recovery both call rebindIfUnhealthy() on this same
  // per-device singleton and can interleave — one re-enables while the other
  // force-stops mid-sequence, leaving the health poll observing a state
  // neither caller intended. Concurrent callers instead share one in-flight
  // rebind and its result. The flight is owned by the manager, not by the first
  // caller (#10199): it runs under a flight-scoped signal that aborts only when
  // every waiter has gone, and each waiter observes its own signal.
  private readonly rebindFlights = new SingleFlight<"rebind", boolean>();

  private rebindFlightKind: RebindFlightKind = "check";

  // Settles when the latest flight has finished, so a flight started after every
  // waiter abandoned its predecessor still waits for that one's restore write.
  private rebindSettled: Promise<void> = Promise.resolve();

  // The latest remove -> re-add section, which a cancelled waiter waits out.
  private rebindMutationSettled: Promise<void> = Promise.resolve();
  constructor(private readonly host: AndroidCtrlProxyRebindHost) {}

  /**
   * Check the framework's binding state separately from the secure-setting
   * configuration. A configured service can remain listed after Android moves
   * it to "Crashed services", so isEnabled() alone cannot establish health.
   */
  async isAccessibilityServiceHealthy(): Promise<boolean> {
    return (await this.accessibilityServiceState()) === "bound";
  }

  /** Distinguish an already-bound service from a bind completed during this wait. */
  async waitForAccessibilityServiceBinding(): Promise<"already-bound" | "recovered" | "unhealthy"> {
    const state = await this.accessibilityServiceState();
    if (state === "bound") {
      return "already-bound";
    }
    return state === "binding" && (await this.waitForHealthyAfterRebind())
      ? "recovered"
      : "unhealthy";
  }

  private async accessibilityServiceState(): Promise<AccessibilityServiceState> {
    const result = await this.host.adb.executeCommand("shell dumpsys accessibility", {
      maxBuffer: DUMPSYS_MAX_BUFFER,
    });
    const output = `${result.stdout}\n${result.stderr}`;
    if (isAndroidFrameworkUnavailable(output)) {
      throw new ActionableError(output);
    }
    // `dumpsys accessibility` lists every user's state in id order; read the setup user's, not user 0's.
    const diagnostic = AndroidCtrlProxyRebind.userStateBlock(output, await this.host.setupUser());

    const boundServices = AndroidCtrlProxyRebind.accessibilityServiceSection(
      diagnostic,
      "Bound services",
    );
    const enabledServices = AndroidCtrlProxyRebind.accessibilityServiceSection(
      diagnostic,
      "Enabled services",
    );
    const bindingServices = AndroidCtrlProxyRebind.accessibilityServiceSection(
      diagnostic,
      "Binding services",
    );
    const crashedServices = AndroidCtrlProxyRebind.accessibilityServiceSection(
      diagnostic,
      "Crashed services",
    );
    const component = CTRL_PROXY_ACCESSIBILITY_SERVICE_COMPONENT;
    const isEnabled = enabledServices.includes(component);
    // API 36 reports bound services by display label; retain component matching
    // for dumpsys versions that identify the bound entry by component instead.
    const isBound = AndroidCtrlProxyRebind.isCtrlProxyBound(boundServices);
    const isBinding = bindingServices.includes(component);
    const isCrashed = crashedServices.includes(component);
    this.recordBindingObservation(isEnabled && isBinding && !isCrashed);
    const state: AccessibilityServiceState = isCrashed
      ? "crashed"
      : !isEnabled
        ? "absent"
        : isBinding
          ? "binding"
          : isBound
            ? "bound"
            : "unbound";
    logger.debug(`[CTRL_PROXY] Accessibility service binding status: ${state}`);
    return state;
  }

  private static isCtrlProxyBound(boundServices: string): boolean {
    return (
      boundServices.includes(CTRL_PROXY_ACCESSIBILITY_SERVICE_COMPONENT) ||
      boundServices.includes(`label=${AndroidCtrlProxyRebind.ACCESSIBILITY_SERVICE_LABEL},`) ||
      boundServices.includes(`label=${AndroidCtrlProxyRebind.ACCESSIBILITY_SERVICE_LABEL}]`)
    );
  }

  private recordBindingObservation(isBinding: boolean): void {
    if (isBinding) {
      this.bindingFirstObservedAt ??= this.host.timer.now();
    } else {
      this.bindingFirstObservedAt = null;
    }
  }

  private isBindingWithinGracePeriod(): boolean {
    return (
      this.bindingFirstObservedAt !== null &&
      this.host.timer.now() - this.bindingFirstObservedAt <=
        AndroidCtrlProxyRebind.REBIND_BIND_GRACE_MS
    );
  }

  /**
   * Remove CtrlProxy from the configured service list and add it back when
   * Android reports it crashed or unbound. Writing the intermediate list keeps
   * every other enabled accessibility service intact while forcing a rebind.
   *
   * Concurrent callers (the #7534 readiness path and a client's own
   * connection-failure recovery, issue #7532) share a single in-flight rebind
   * rather than interleaving their own force-stop/settings sequences against
   * the same on-device service.
   */
  async rebindIfUnhealthy(): Promise<boolean> {
    await this.host.assertNotDrivenByOtherDaemon();
    return this.runRebindFlight("check");
  }

  /**
   * Force-stop and re-add the accessibility service unconditionally — see the
   * {@link CtrlProxyManager.forceRestartProcess} doc for why this is distinct
   * from {@link rebindIfUnhealthy} (issue #7533). Shares `rebindIfUnhealthy`'s
   * single-flight guard (#7532) so the two recovery paths never interleave
   * force-stop/settings writes against the same device, and refuses to run
   * against a device adb no longer lists as present so a caller cannot turn
   * this into a restart loop.
   */
  async forceRestartProcess(): Promise<boolean> {
    await this.host.assertNotDrivenByOtherDaemon();
    for (;;) {
      const joinedKind = this.rebindFlights.has("rebind") ? this.rebindFlightKind : "force";
      const restarted = await this.runRebindFlight("force");
      // A healthy-binding check can finish without changing the process, so a
      // force request that only joined one runs again once it has settled.
      if (joinedKind === "force" || restarted) {
        return restarted;
      }
    }
  }

  /**
   * Join the shared rebind flight, starting one when none is running. The caller
   * waits under its OWN signal; the flight itself is not the caller's (#10199).
   */
  private async runRebindFlight(kind: RebindFlightKind): Promise<boolean> {
    const signal = getAbortSignal();
    if (!this.rebindFlights.has("rebind")) {
      // SingleFlight starts the task a microtask after registering the flight, so
      // record the kind here, synchronously, for a same-turn force caller to read.
      this.rebindFlightKind = kind;
    }
    try {
      return await this.rebindFlights.run(
        "rebind",
        (flightSignal) => this.startRebindFlight(kind, flightSignal),
        signal,
        { cancelWhenAllWaitersAbort: true },
      );
    } catch (error) {
      if (signal?.aborted) {
        // Report the cancellation only after the flight's remove -> re-add section
        // (bounded by its own timeouts) has restored the service.
        await this.rebindMutationSettled;
      }
      throw error;
    }
  }

  private startRebindFlight(kind: RebindFlightKind, flightSignal?: AbortSignal): Promise<boolean> {
    const previous = this.rebindSettled;
    const flight = (async () => {
      await previous;
      // The flight is created inside the first caller's async context; detach from
      // that caller's signal so only the flight-scoped signal governs it.
      return runWithAbortSignal(flightSignal, () =>
        kind === "force" ? this.forceRestartIfPresent() : this.rebindOrRestartInternal(false),
      );
    })();
    this.rebindSettled = flight.then(
      () => undefined,
      () => undefined,
    );
    return flight;
  }

  private async forceRestartIfPresent(): Promise<boolean> {
    if (!(await this.isDevicePresent())) {
      logger.info(
        `[CTRL_PROXY] Device ${this.host.device.deviceId} is offline or missing; skipping process restart`,
      );
      return false;
    }
    return this.rebindOrRestartInternal(true);
  }

  /**
   * Whether adb still reports this device as present and online. Mirrors
   * `AndroidCtrlProxyClient.isDevicePresent` (issue #7532): restart must not
   * touch a stopped or disconnected device.
   */
  private async isDevicePresent(): Promise<boolean> {
    const getDeviceStates = this.host.adb.getDeviceStates?.bind(this.host.adb);
    if (!getDeviceStates) {
      // The executor cannot report raw device states; fail open rather than
      // block recovery on a capability the executor doesn't provide.
      return true;
    }
    try {
      const states = await getDeviceStates();
      const match = states.find((state) => state.deviceId === this.host.device.deviceId);
      // "unauthorized" is not a state a restart can act on either — adb cannot
      // run shell commands against it, so it is not meaningfully "present".
      return match !== undefined && match.state !== "offline" && match.state !== "unauthorized";
    } catch (error) {
      // Diagnostic failure only: do not block the restart on it.
      logger.warn(`[CTRL_PROXY] Failed to check device state before process restart: ${error}`);
      return true;
    }
  }

  private async rebindOrRestartInternal(force: boolean): Promise<boolean> {
    let rebindAttempted = false;
    try {
      if (!force) {
        if (
          (await this.host.isAccessibilityServiceHealthy()) ||
          this.isBindingWithinGracePeriod()
        ) {
          return false;
        }
      }

      const plan = await this.readRebindPlan();
      rebindAttempted = true;
      await this.rebindServicesShielded(plan, force);
      const healthy = await this.waitForHealthyAfterRebind();
      logger.info(
        force
          ? `[CTRL_PROXY] Process restart attempted via settings and force-stop for a connected-but-unresponsive service (${healthy ? "bound" : "still unhealthy"})`
          : `[CTRL_PROXY] Accessibility service was crashed or unbound; rebind attempted via settings and force-stop (${healthy ? "bound" : "still unhealthy"})`,
      );
      return true;
    } catch (error) {
      throw this.rebindFailure(error, force, rebindAttempted);
    } finally {
      if (rebindAttempted) {
        // A rebind changes both the configured and framework-visible state.
        this.host.clearAvailabilityCache();
      }
    }
  }

  private async readRebindPlan(): Promise<RebindPlan> {
    const user = await this.host.setupUser();
    const result = await this.host.adb.executeCommand(
      settingsCommand(user, "get secure enabled_accessibility_services"),
    );
    const diagnostic = `${result.stdout}\n${result.stderr}`;
    if (isAndroidFrameworkUnavailable(diagnostic)) {
      throw new ActionableError(diagnostic);
    }
    const otherServices = AndroidCtrlProxyRebind.accessibilityServices(result.stdout).filter(
      (service) => !service.includes(CTRL_PROXY_PACKAGE),
    );
    return {
      withoutCtrlProxy: otherServices.join(":"),
      withCtrlProxy: [...otherServices, CTRL_PROXY_ACCESSIBILITY_SERVICE_COMPONENT].join(":"),
      user,
    };
  }

  /**
   * Remove CtrlProxy, force-stop it and add it back. Once the removal write is
   * sent the re-add is mandatory cleanup, so every write here runs under a
   * private bounded signal rather than the flight's: a cancelled caller must not
   * leave CtrlProxy out of enabled_accessibility_services (#10199). A flight that
   * was abandoned mid-way skips the force-stop but still re-adds the service.
   */
  private async rebindServicesShielded(plan: RebindPlan, force: boolean): Promise<void> {
    // Never begin the remove -> re-add section for a flight nobody waits on.
    getAbortSignal()?.throwIfAborted();
    const section = this.removeAndReaddShielded(plan, force);
    this.rebindMutationSettled = section.then(
      () => undefined,
      () => undefined,
    );
    await section;
    getAbortSignal()?.throwIfAborted();
  }

  private async removeAndReaddShielded(plan: RebindPlan, force: boolean): Promise<void> {
    try {
      await this.writeEnabledServicesShielded(plan.withoutCtrlProxy, plan.user);
      // The old binding attempt ended when its enabled-service entry was removed.
      this.bindingFirstObservedAt = null;
      if (!getAbortSignal()?.aborted) {
        await this.runShieldedCommand(`shell am force-stop ${CTRL_PROXY_PACKAGE}`);
        await this.host.timer.sleep(AndroidCtrlProxyRebind.REBIND_FORCE_STOP_SETTLE_MS);
      }
      await this.writeCtrlProxyEnabledShielded(plan.withCtrlProxy, plan.user);
    } catch (error) {
      throw await this.restoreAfterRebindFailure(error, plan.withCtrlProxy, plan.user, force);
    }
  }

  /**
   * Add CtrlProxy to the list that is configured NOW rather than the one read
   * before the section began: a service enabled by something else in between (for
   * example TalkBack through the `accessibility` tool) must not be dropped. The
   * remembered list is only the fallback when the live one cannot be read.
   */
  private async writeCtrlProxyEnabledShielded(
    rememberedServices: string,
    user: number | undefined,
  ): Promise<void> {
    await this.writeEnabledServicesShielded(
      await this.liveServicesWithCtrlProxy(rememberedServices, user),
      user,
    );
  }

  private async liveServicesWithCtrlProxy(
    rememberedServices: string,
    user: number | undefined,
  ): Promise<string> {
    try {
      const result = await this.runShieldedCommand(
        settingsCommand(user, "get secure enabled_accessibility_services"),
      );
      const diagnostic = `${result.stdout}\n${result.stderr}`;
      if (isAndroidFrameworkUnavailable(diagnostic)) {
        throw new ActionableError(diagnostic);
      }
      return AndroidCtrlProxyRebind.withCtrlProxyService(
        AndroidCtrlProxyRebind.accessibilityServices(result.stdout),
      );
    } catch (error) {
      logger.warn(
        `[CTRL_PROXY] Could not read the live enabled_accessibility_services (${errorMessage(error)}); ` +
          `re-adding CtrlProxy to the remembered service list read before the rebind, which may drop a service enabled since`,
        error,
      );
      return rememberedServices;
    }
  }

  private static withCtrlProxyService(services: string[]): string {
    return [
      ...services.filter((service) => !service.includes(CTRL_PROXY_PACKAGE)),
      CTRL_PROXY_ACCESSIBILITY_SERVICE_COMPONENT,
    ].join(":");
  }

  private writeEnabledServicesShielded(
    services: string,
    user: number | undefined,
  ): Promise<unknown> {
    return this.runShieldedCommand(
      settingsCommand(user, `put secure enabled_accessibility_services ${shellQuote(services)}`),
    );
  }

  private async runShieldedCommand(command: string): Promise<ExecResult> {
    const env = this.host.env ?? process.env;
    const first = loadScaledBudget(
      {
        baseMs: readEnvInt(ENV.CTRL_PROXY_REBIND_WRITE_TIMEOUT_MS, env),
        ceilingMs: readEnvInt(ENV.CTRL_PROXY_REBIND_WRITE_TIMEOUT_MAX_MS, env),
      },
      this.host.hostLoad ?? defaultHostLoadReader(),
    );
    return this.shieldedAttempt(command, first, first.budgetMs, false);
  }

  private async shieldedAttempt(
    command: string,
    first: LoadScaledBudget,
    timeoutMs: number,
    retry: boolean,
  ): Promise<ExecResult> {
    const shield = new AbortController();
    let timedOut = false;
    let started: Promise<ExecResult> | undefined;
    const timeoutError = () =>
      new ActionableError(
        `CtrlProxy rebind write timed out after ${timeoutMs}ms (budget-driven: ${describeLoadScaledBudget(first)})`,
      );
    try {
      return await raceWithDeadline(
        () => {
          started = this.host.adb.executeCommand(command, {
            signal: shield.signal,
            waitForProcessSettlementAfterAbort: true,
          });
          return started;
        },
        {
          timer: this.host.timer,
          timeoutMs,
          label: "CtrlProxy rebind write",
          timeoutError,
          onTimeout: () => {
            timedOut = true;
            shield.abort(timeoutError());
          },
        },
      );
    } catch (error) {
      if (!timedOut || retry) {
        throw error;
      }
      logger.warn(`Retrying CtrlProxy rebind write: ${errorMessage(error)}`, error);
      // Never overlap the abandoned attempt: a late-landing earlier write could undo the
      // retry's successors (for example the re-add after the removal).
      await this.waitForAbandonedWrite(started, retryBudget(first), error);
      return this.shieldedAttempt(command, first, retryBudget(first), true);
    }
  }

  private async waitForAbandonedWrite(
    started: Promise<ExecResult> | undefined,
    timeoutMs: number,
    timeout: unknown,
  ): Promise<void> {
    if (!started) {
      return;
    }
    await raceWithDeadline(
      started.then(
        () => undefined,
        () => undefined,
      ),
      {
        timer: this.host.timer,
        timeoutMs,
        label: "CtrlProxy abandoned rebind write settlement",
        timeoutError: () => timeout,
      },
    );
  }

  /**
   * Compensating write after a failure past the removal: put CtrlProxy back so the
   * service is not left disabled (#7859). Returns the error to throw, which names
   * the stranded state when the restore itself failed.
   */
  private async restoreAfterRebindFailure(
    error: unknown,
    servicesWithCtrlProxy: string,
    user: number | undefined,
    force: boolean,
  ): Promise<unknown> {
    try {
      await this.writeCtrlProxyEnabledShielded(servicesWithCtrlProxy, user);
      return error;
    } catch (restoreError) {
      logger.warn(
        `[CTRL_PROXY] Failed to restore accessibility services: ${restoreError}`,
        restoreError,
      );
      return new ActionableError(
        `${AndroidCtrlProxyRebind.rebindFailureContext(force)}: ${errorMessage(error)}. ` +
          `Restoring CtrlProxy to enabled_accessibility_services also failed (${errorMessage(restoreError)}), ` +
          `so CtrlProxy is left disabled on this device until the next rebind or readiness check re-adds it.`,
        { cause: error },
      );
    }
  }

  private static rebindFailureContext(force: boolean): string {
    return force
      ? "Failed to force-restart connected-but-unresponsive CtrlProxy process"
      : "Failed to rebind crashed or unbound CtrlProxy accessibility service";
  }

  private rebindFailure(error: unknown, force: boolean, rebindAttempted: boolean): ActionableError {
    if (!rebindAttempted) {
      return new CtrlProxyInspectionError(errorMessage(error));
    }
    return toActionableError(error, AndroidCtrlProxyRebind.rebindFailureContext(force));
  }

  private async waitForHealthyAfterRebind(): Promise<boolean> {
    const startedAt = this.host.timer.now();
    for (;;) {
      const state = await this.accessibilityServiceState();
      if (state === "bound") {
        return true;
      }
      if (state === "crashed" || state === "absent") {
        return false;
      }
      const remainingMs = REBIND_BIND_WAIT_BUDGET_MS - (this.host.timer.now() - startedAt);
      if (remainingMs <= 0) {
        return false;
      }
      await this.host.timer.sleep(
        Math.min(AndroidCtrlProxyRebind.REBIND_HEALTH_POLL_MS, remainingMs),
      );
    }
  }

  /**
   * The `User state[` block of `dumpsys accessibility` for [user] (its `attributes:{id=<user>,`), or the
   * whole dump when no user is targeted or no block names that user. AOSP prints one block per user in id
   * order, so without this a headless device reads user 0's empty state.
   */
  static userStateBlock(output: string, user: number | undefined): string {
    if (user === undefined) {
      return output;
    }
    const blocks = output.split(/^[\t ]*User state\[/m).slice(1);
    const idPattern = new RegExp(`\\bid=${user}\\b`);
    // A dump can repeat the header line for one user; the fullest block is the one with the services.
    const own = blocks
      .filter((block) => idPattern.test(block.slice(0, 200)))
      .sort((left, right) => right.length - left.length)[0];
    return own ?? output;
  }

  private static accessibilityServiceSection(output: string, name: string): string {
    const header = new RegExp(`^[\\t ]*${name}:[\\t ]*\\{`, "m");
    const match = header.exec(output);
    if (!match) {
      return "";
    }
    const start = match.index + match[0].length - 1;
    let depth = 0;
    for (let index = start; index < output.length; index++) {
      if (output[index] === "{") {
        depth++;
      } else if (output[index] === "}" && --depth === 0) {
        return output.slice(start + 1, index);
      }
    }
    return "";
  }

  private static accessibilityServices(value: string): string[] {
    const trimmed = value.trim();
    if (trimmed === "" || trimmed === "null") {
      return [];
    }
    return trimmed.split(":").filter((service) => service !== "");
  }
}
