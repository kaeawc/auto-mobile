import {
  NETWORK_CONDITION_PROFILES,
  IOS_PHYSICAL_NETWORK_CONDITION_UNSUPPORTED_ERROR,
  iosSimulatorNetworkConditionError,
  IOS_SIMULATOR_NETWORK_CONDITION_APP_REQUIRED_ERROR,
  IOS_SIMULATOR_NETWORK_CONDITION_SESSION_REQUIRED_ERROR,
  IOS_APP_NETWORK_CONDITION_LIMITATIONS,
  iosUnsupportedNetworkConditionError,
  ANDROID_PHYSICAL_NETWORK_CONDITION_UNSUPPORTED_ERROR,
  parseEmulatorNetworkStatus,
  resolveNetworkProfile,
  resolveNetworkValues,
  classifyNetworkConditionRequest,
  hasShapingOverride,
  wifiToggleCommand,
  NETWORK_CONDITION_PARTIAL_WARNING,
  NETWORK_CONDITION_LOSS_ONLY_UNSUPPORTED_ERROR,
  NETWORK_CONDITION_EMPTY_REQUEST_ERROR,
  NETWORK_CONDITION_OFFLINE_OVERRIDE_ERROR,
  NETWORK_CONDITION_ROLLBACK_COMMAND_TIMEOUT_MS,
  NETWORK_CONDITION_ROLLBACK_TOTAL_TIMEOUT_MS,
  NETWORK_CONDITION_ROLLBACK_COMMANDS,
  buildEmulatorNetworkCommands,
  type NetworkConditionProfile,
  type NetworkConditionValues,
  type NetworkConditionBackendState,
  type IosAppNetworkRuleState,
  type NetworkConditionState,
  type NetworkConditionResultBase,
  type SetNetworkConditionInput,
} from "./NetworkConditionState";
import { runWithAbortSignal } from "../../../utils/AbortContext";
import { raceWithDeadline } from "../../../utils/raceWithDeadline";
import { errorMessage } from "../../../utils/describeUnknownError";
import type { AdbClientFactory } from "../../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { BootedDevice } from "../../../models";
import { isIosSimulatorDevice } from "../../action/IosSimulatorPermissions";
import { outputLooksLikeShellFailure } from "../../../utils/android-cmdline-tools/shellOutputHeuristics";
import { emulatorConsoleReportsFailure } from "../../../utils/android-cmdline-tools/emulatorConsoleReply";
import { logger } from "../../../utils/logger";
import type { Timer } from "../../../utils/SystemTimer";
import { isAndroidEmulatorSerial } from "../../../utils/androidSerial";
import {
  networkFilterNextStep,
  type NetworkFilterBridge,
  type NetworkFilterStatus,
} from "../../networkFilter/NetworkFilterBridge";
import {
  IOS_APP_NETWORK_RULE_LEASE_MS,
  IosAppNetworkRuleClient,
  type IosAppNetworkApplyResult,
  type IosAppNetworkResetResult,
  type IosAppNetworkRuleCommandContext,
} from "../../networkFilter/IosAppNetworkRuleClient";

interface NetworkConditionOperationsDependencies {
  device: () => BootedDevice;
  adbFactory: () => AdbClientFactory;
  timer: () => Timer;
  networkFilterBridge: () => NetworkFilterBridge;
  iosAppNetworkRule: () => IosAppNetworkRuleCommandContext | undefined;
}

interface EmulatorNetworkConditionRequest {
  profile: NetworkConditionProfile;
  effectiveInput: SetNetworkConditionInput;
  values: NetworkConditionValues;
  degrades: boolean;
  isReset: boolean;
  input: SetNetworkConditionInput;
  base: NetworkConditionResultBase;
}

export class NetworkConditionOperations {
  constructor(private readonly dependencies: NetworkConditionOperationsDependencies) {}

  /** Platform dispatch for reading the device-wide network condition. */
  async read(): Promise<NetworkConditionState> {
    return this.dependencies.device().platform === "android"
      ? this.getAndroidNetworkCondition()
      : this.getIosNetworkCondition();
  }

  /** Platform dispatch for writing the device-wide network condition. */
  async write(input: SetNetworkConditionInput): Promise<NetworkConditionState> {
    return this.dependencies.device().platform === "android"
      ? this.setAndroidNetworkCondition(input)
      : this.setIosNetworkCondition(input);
  }

  private async getAndroidNetworkCondition(): Promise<NetworkConditionState> {
    if (!isAndroidEmulatorSerial(this.dependencies.device().deviceId)) {
      return {
        supported: false,
        capability: "unsupported",
        error: ANDROID_PHYSICAL_NETWORK_CONDITION_UNSUPPORTED_ERROR,
      };
    }
    // The emulator console has no structured "get" for the applied delay/speed,
    // so readback is best-effort: `network status` prints the current shaping as
    // free text. We surface it verbatim (rawStatus). A clean response only proves
    // the console is REACHABLE — it does not verify any specific condition (no
    // profile/values are reconstructed), so the read deliberately does NOT set
    // `verified: true` (issue #6012 review): `verified` is reserved for an applied
    // condition that was actually achieved. The applied profile is tracked at the
    // session layer, not re-derived here.
    try {
      const adb = this.dependencies.adbFactory().create(this.dependencies.device());
      const result = await adb.executeCommand("emu network status", { noRetry: true });
      const stdout = result.stdout;
      const stderr = result.stderr ?? "";
      if (emulatorConsoleReportsFailure(stdout, stderr)) {
        return {
          supported: true,
          capability: "full",
          method: "android_emulator_console",
          verified: false,
          error: `${stdout}\n${stderr}`.trim() || "emu network status reported an error",
        };
      }
      // Best-effort structured readback (issue #6085 item 3): parse the free-text
      // status into applied delay/speed when the format allows, keeping rawStatus
      // verbatim as the fallback. A parse failure is silent — no structured field
      // is claimed and rawStatus still carries the raw signal.
      const trimmed = stdout.trim();
      const observedValues = trimmed ? parseEmulatorNetworkStatus(trimmed) : null;
      return {
        supported: true,
        capability: "full",
        method: "android_emulator_console",
        ...(trimmed ? { rawStatus: trimmed } : {}),
        ...(observedValues ? { observedValues } : {}),
      };
    } catch (error) {
      return {
        supported: true,
        capability: "full",
        method: "android_emulator_console",
        verified: false,
        error: errorMessage(error),
      };
    }
  }

  private async getIosNetworkCondition(): Promise<NetworkConditionState> {
    if (!isIosSimulatorDevice(this.dependencies.device())) {
      return {
        supported: false,
        capability: "unsupported",
        error: IOS_PHYSICAL_NETWORK_CONDITION_UNSUPPORTED_ERROR,
      };
    }
    const status = await this.readNetworkFilterStatus();
    const controller = this.networkFilterController(status);
    if (status.state !== "ready") {
      return {
        supported: false,
        capability: "unsupported",
        backend: "network-extension",
        controller,
        error: iosSimulatorNetworkConditionError(status.state),
      };
    }
    // Read from the provider, never echoed from the last request.
    const udid = this.dependencies.device().deviceId.toUpperCase();
    const rules = (status.rules ?? [])
      .filter((rule) => rule.target.simulator.udid.toUpperCase() === udid)
      // Shaped rules are reported in a later change.
      .filter((rule) => rule.condition === "offline")
      .map((rule): IosAppNetworkRuleState => ({
        appId: rule.target.bundleId,
        profile: rule.condition,
        revision: rule.revision,
        ownerGeneration: rule.ownerGeneration,
        owner: rule.owner,
        leaseExpiresInMs: rule.leaseRemainingMilliseconds,
        droppedFlows: rule.droppedFlows,
      }));
    return {
      supported: true,
      capability: "partial",
      backend: "network-extension",
      controller,
      scope: "app",
      rules,
      coverage: "partial",
      limitations: [...IOS_APP_NETWORK_CONDITION_LIMITATIONS],
    };
  }

  private networkFilterController(status: NetworkFilterStatus): NetworkConditionBackendState {
    return {
      state: status.state,
      ...(status.contractVersion !== undefined ? { contractVersion: status.contractVersion } : {}),
      detail: status.detail,
      nextStep: networkFilterNextStep(status.state),
    };
  }

  /** The bridge resolves every failure to a state; this guards the read path regardless. */
  private async readNetworkFilterStatus(): Promise<NetworkFilterStatus> {
    try {
      return await this.dependencies.networkFilterBridge().status();
    } catch (error) {
      logger.warn(`[DeviceState] network filter status failed: ${errorMessage(error)}`, error);
      return { state: "unavailable", detail: errorMessage(error) };
    }
  }

  private async setAndroidNetworkCondition(
    input: SetNetworkConditionInput,
  ): Promise<NetworkConditionState> {
    if (input.appId !== undefined) {
      return {
        supported: false,
        capability: "unsupported",
        requestedProfile: resolveNetworkProfile(input),
        verified: false,
        error:
          "networkCondition.appId applies only to iOS Simulator; Android network conditions are device-wide.",
      };
    }
    const kind = classifyNetworkConditionRequest(input);
    // A reset restores normal connectivity, so shaping overrides on the same
    // request are contradictory — drop them rather than apply latency while
    // reporting `none` (issue #6012 review). `resolveNetworkProfile` still reads
    // the original input to detect the cancel/reset intent.
    const isReset = kind === "reset";
    const effectiveInput: SetNetworkConditionInput = isReset
      ? { expiresInSeconds: input.expiresInSeconds }
      : input;
    const profile = resolveNetworkProfile(input);
    const values = resolveNetworkValues(profile, effectiveInput);
    const degrades = kind === "degrade";
    const expires =
      input.expiresInSeconds !== undefined ? { expiresInSeconds: input.expiresInSeconds } : {};
    const base = {
      method: "android_emulator_console" as const,
      requestedProfile: profile,
      values,
      ...expires,
    };
    // Non-applying kinds are answered before touching the device or the platform
    // guard: they issue no console command, so — like the physical-device branch —
    // they do NOT claim the emulator-console `method` (issue #6012 review). They
    // register no restore slot and are never reported verified.
    if (kind === "empty" || kind === "invalid" || kind === "loss-only") {
      const error =
        kind === "invalid"
          ? NETWORK_CONDITION_OFFLINE_OVERRIDE_ERROR
          : kind === "loss-only"
            ? NETWORK_CONDITION_LOSS_ONLY_UNSUPPORTED_ERROR
            : NETWORK_CONDITION_EMPTY_REQUEST_ERROR;
      // Echo the profile's documented baseline, NOT the caller's overrides —
      // nothing was applied, so an unapplied override must not appear in `values`
      // (issue #6012 review, the offline+override echo bug).
      return {
        supported: false,
        capability: "unsupported",
        requestedProfile: profile,
        values: NETWORK_CONDITION_PROFILES[profile],
        verified: false,
        ...expires,
        error,
      };
    }
    if (!isAndroidEmulatorSerial(this.dependencies.device().deviceId)) {
      // Physical device: no emulator console, so do not claim its method.
      return {
        supported: false,
        capability: "unsupported",
        requestedProfile: profile,
        values,
        verified: false,
        ...expires,
        error: ANDROID_PHYSICAL_NETWORK_CONDITION_UNSUPPORTED_ERROR,
      };
    }
    return this.applyEmulatorNetworkCondition({
      profile,
      effectiveInput,
      values,
      degrades,
      isReset,
      input,
      base,
    });
  }

  /**
   * Issue the emulator shaping commands and assemble the result. Any failure —
   * a `KO` result OR a thrown command — rolls a degrade back to normal
   * connectivity (best-effort) so a partial application is never left on the
   * device (issue #6012 review P2).
   */
  private async applyEmulatorNetworkCondition(
    request: EmulatorNetworkConditionRequest,
  ): Promise<NetworkConditionState> {
    const { profile, effectiveInput, values, degrades, base } = request;
    const failure = (error: string): NetworkConditionState => ({
      supported: true,
      capability: degrades ? "partial" : "full",
      verified: false,
      ...base,
      error,
    });
    let adb: AdbExecutor;
    try {
      adb = this.dependencies.adbFactory().create(this.dependencies.device());
    } catch (error) {
      return failure(errorMessage(error));
    }
    try {
      const commandError = await this.runEmulatorNetworkCommands(
        adb,
        buildEmulatorNetworkCommands(profile, effectiveInput, values),
      );
      if (commandError) {
        if (degrades) {
          await this.rollbackNetworkConditionToNone(adb);
        }
        return failure(commandError);
      }
      // Toggle Wi-Fi so a shaping/cut condition reaches traffic (best-effort;
      // never aborts — a failure only feeds the `partial`/unverified report).
      const wifiWarning = await this.toggleWifiBestEffort(adb, wifiToggleCommand(degrades));
      return this.buildAppliedNetworkResult(request, wifiWarning);
    } catch (error) {
      // A THROWN command can also leave a partial application, so roll back a
      // degrade here too — the `KO` path is not the only failure mode.
      if (degrades) {
        await this.rollbackNetworkConditionToNone(adb);
      }
      return failure(errorMessage(error));
    }
  }

  /** Best-effort rollback to normal connectivity after a failed degrade sequence. */
  private async rollbackNetworkConditionToNone(adb: AdbExecutor): Promise<void> {
    await runWithAbortSignal(undefined, async () => {
      const deadline =
        this.dependencies.timer().now() + NETWORK_CONDITION_ROLLBACK_TOTAL_TIMEOUT_MS;
      for (const command of NETWORK_CONDITION_ROLLBACK_COMMANDS) {
        const remainingMs = Math.max(0, deadline - this.dependencies.timer().now());
        if (remainingMs === 0) {
          break;
        }
        const timeoutMs = Math.min(NETWORK_CONDITION_ROLLBACK_COMMAND_TIMEOUT_MS, remainingMs);
        const cleanup = new AbortController();
        try {
          await raceWithDeadline(
            () => adb.executeCommand(command, { timeoutMs, noRetry: true, signal: cleanup.signal }),
            {
              timer: this.dependencies.timer(),
              timeoutMs,
              signal: cleanup.signal,
              label: "Emulator network-condition rollback",
              onTimeout: () => cleanup.abort(),
            },
          );
        } catch (error) {
          // The original typed failure must survive a failed connectivity restore.
          logger.warn(`[DeviceState] network rollback '${command}' failed`, error);
        }
      }
    });
  }

  /**
   * Run the emulator shaping commands in order. Returns an error string on the
   * first command the console rejects (`KO`/shell failure), or null when all
   * succeeded.
   */
  private async runEmulatorNetworkCommands(
    adb: AdbExecutor,
    commands: string[],
  ): Promise<string | null> {
    for (const command of commands) {
      const result = await adb.executeCommand(command, { noRetry: true });
      const stdout = result.stdout;
      const stderr = result.stderr ?? "";
      if (emulatorConsoleReportsFailure(stdout, stderr)) {
        return `${stdout}\n${stderr}`.trim() || `${command} reported an error`;
      }
    }
    return null;
  }

  /** Assemble the success result for an applied (or reset) network condition. */
  private buildAppliedNetworkResult(
    {
      base,
      profile,
      degrades,
      isReset,
      input,
    }: Pick<EmulatorNetworkConditionRequest, "base" | "profile" | "degrades" | "isReset" | "input">,
    wifiWarning: string | undefined,
  ): NetworkConditionState {
    const applied = { supported: true as const, profile, appliedProfile: profile, ...base };
    if (!degrades) {
      const overrideDiscarded = isReset && hasShapingOverride(input);
      const overrideNote = overrideDiscarded
        ? "Shaping overrides were ignored because cancel/reset was requested."
        : undefined;
      if (wifiWarning) {
        // Reset could not re-enable Wi-Fi, so connectivity is NOT fully restored.
        // Reporting verified success here would stop the session restorer from
        // retrying and leave the device with Wi-Fi off (issue #6012 review P1).
        // Report unverified + error so the restorer keeps retrying / quarantines.
        return {
          ...applied,
          capability: "partial",
          verified: false,
          error: overrideNote ? `${overrideNote} ${wifiWarning}` : wifiWarning,
        };
      }
      // Reset removes all shaping and re-enables both radios — the safe restore
      // direction, fully applied and verifiable-by-completion.
      return {
        ...applied,
        capability: "full",
        verified: true,
        ...(overrideNote ? { warning: overrideNote } : {}),
      };
    }
    // Degrading profile (including offline): the commands were accepted, but
    // effectiveness depends on the emulator's transport and the best-effort
    // Wi-Fi toggle, so report `partial` with a warning and NO `verified: true`.
    return {
      ...applied,
      capability: "partial",
      warning: wifiWarning
        ? `${NETWORK_CONDITION_PARTIAL_WARNING} (${wifiWarning})`
        : NETWORK_CONDITION_PARTIAL_WARNING,
    };
  }

  /**
   * Toggle Wi-Fi via `svc wifi`, swallowing failure. Returns a short warning
   * fragment when the toggle did not cleanly succeed (so the caller can fold it
   * into the `partial` report), or undefined on success. Never throws: Wi-Fi
   * toggling is best-effort and its failure must not fail the whole request.
   */
  private async toggleWifiBestEffort(
    adb: AdbExecutor,
    command: string,
  ): Promise<string | undefined> {
    try {
      const result = await adb.executeCommand(command, { noRetry: true });
      const stdout = result.stdout;
      const stderr = result.stderr ?? "";
      if (outputLooksLikeShellFailure(stdout, stderr)) {
        return `Wi-Fi toggle '${command}' reported: ${`${stdout} ${stderr}`.trim()}`;
      }
      return undefined;
    } catch (error) {
      // Connection/permission failures here are expected on some API levels and
      // must not abort the shaping request; surface them only as a warning.
      logger.debug(`[DeviceState] wifi toggle '${command}' failed: ${error}`);
      return `Wi-Fi toggle '${command}' failed: ${errorMessage(error)}`;
    }
  }

  /**
   * iOS Simulator: take one explicitly named app offline, or restore it, through
   * the leased network-extension rule (#10264). Device-wide requests and every
   * profile but `offline`/`none` are refused without contacting the controller.
   */
  private async setIosNetworkCondition(
    input: SetNetworkConditionInput,
  ): Promise<NetworkConditionState> {
    const profile = resolveNetworkProfile(input);
    if (!isIosSimulatorDevice(this.dependencies.device())) {
      return {
        ...(await this.getIosNetworkCondition()),
        requestedProfile: profile,
        verified: false,
      };
    }
    const refused = (
      error: string,
      extra: Partial<NetworkConditionState> = {},
    ): NetworkConditionState => ({
      supported: false,
      capability: "unsupported",
      backend: "network-extension",
      requestedProfile: profile,
      verified: false,
      ...extra,
      error,
    });
    if (!input.appId) {
      return refused(IOS_SIMULATOR_NETWORK_CONDITION_APP_REQUIRED_ERROR, { scope: "device" });
    }
    const kind = classifyNetworkConditionRequest(input);
    const isReset = kind === "reset";
    if (!isReset && !(kind === "degrade" && profile === "offline")) {
      return refused(iosUnsupportedNetworkConditionError(input), {
        scope: "app",
        appId: input.appId,
      });
    }
    const base: NetworkConditionState = {
      supported: true,
      capability: "partial",
      backend: "network-extension",
      scope: "app",
      appId: input.appId,
      requestedProfile: profile,
      coverage: "partial",
      limitations: [...IOS_APP_NETWORK_CONDITION_LIMITATIONS],
    };
    const context = this.dependencies.iosAppNetworkRule();
    if (!context) {
      return { ...base, error: IOS_SIMULATOR_NETWORK_CONDITION_SESSION_REQUIRED_ERROR };
    }
    const client = new IosAppNetworkRuleClient(this.dependencies.networkFilterBridge());
    return isReset
      ? this.iosResetResult(base, context, await client.reset(context.rule))
      : this.iosApplyResult(
          base,
          context,
          await client.applyOffline(
            context.rule,
            IOS_APP_NETWORK_RULE_LEASE_MS,
            context.nextRevision,
          ),
        );
  }

  private iosApplyResult(
    base: NetworkConditionState,
    context: IosAppNetworkRuleCommandContext,
    result: IosAppNetworkApplyResult,
  ): NetworkConditionState {
    const { rule } = context;
    switch (result.kind) {
      case "applied":
        return {
          ...base,
          profile: "offline",
          appliedProfile: "offline",
          acknowledged: true,
          rule: {
            appId: rule.bundleId,
            profile: "offline",
            revision: result.installedRevision,
            ownerGeneration: rule.ownerGeneration,
            ...(result.leaseRemainingMs !== undefined
              ? { leaseExpiresInMs: result.leaseRemainingMs }
              : {}),
          },
          ...(result.reconciled
            ? {
                warning:
                  "The controller's answer was lost; a status read-back found the rule installed.",
              }
            : {}),
        };
      case "refused":
        return {
          ...base,
          verified: false,
          error: iosRuleRefusalError(rule.bundleId, result.outcome),
        };
      case "upgrade_required":
        return this.iosApplyResult(base, context, {
          kind: "not_ready",
          state: "unavailable",
          detail: result.detail,
        });
      case "not_ready":
        return {
          ...base,
          supported: false,
          capability: "unsupported",
          controller: this.networkFilterController({ state: result.state, detail: result.detail }),
          verified: false,
          error: iosSimulatorNetworkConditionError(result.state),
        };
      case "failed":
        return {
          ...base,
          verified: false,
          controller: this.networkFilterController({ state: result.state, detail: result.detail }),
          error:
            `The network filter did not confirm taking ${rule.bundleId} offline (${result.detail}), ` +
            `and a read-back did not find the rule; ${result.rolledBack ? "it was rolled back" : "a rollback was sent but not confirmed, so any late rule ends with its lease"}. ` +
            networkFilterNextStep(result.state),
        };
    }
  }

  private iosResetResult(
    base: NetworkConditionState,
    context: IosAppNetworkRuleCommandContext,
    result: IosAppNetworkResetResult,
  ): NetworkConditionState {
    const { rule } = context;
    switch (result.kind) {
      case "reset":
        return {
          ...base,
          profile: "none",
          appliedProfile: "none",
          acknowledged: true,
          ...(result.reconciled
            ? { warning: "The controller's answer was lost; a status read-back found no rule." }
            : {}),
        };
      case "refused":
        return {
          ...base,
          verified: false,
          error: iosRuleRefusalError(rule.bundleId, result.outcome),
        };
      case "failed":
        return {
          ...base,
          verified: false,
          controller: this.networkFilterController({ state: result.state, detail: result.detail }),
          error:
            `The network filter did not confirm restoring ${rule.bundleId} (${result.detail}). ` +
            `Any rule this session holds ends with its lease. ${networkFilterNextStep(result.state)}`,
        };
    }
  }
}

function iosRuleRefusalError(bundleId: string, outcome: string): string {
  switch (outcome) {
    case "owned_by_another_session":
      return (
        `Another session holds the offline rule for ${bundleId} on this simulator; it was not ` +
        "changed. It ends when that session resets or releases it, or its lease expires."
      );
    case "stale_generation":
    case "stale_revision":
      return `A newer command from this session for ${bundleId} superseded this one (${outcome}); nothing changed.`;
    default:
      return `The network filter refused the rule for ${bundleId}: ${outcome}.`;
  }
}
