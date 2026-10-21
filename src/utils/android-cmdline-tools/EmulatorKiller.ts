import {
  emulatorProcessEscapeHint,
  EmulatorStillRunningError,
  markEmulatorStopDispatched,
  type EmulatorProcessIdentity,
  type EmulatorSerialDescription,
  type EmulatorProcessStopper,
} from "./EmulatorProcessStop";
import { AdbCommandTimeoutError } from "./AdbClient";
import type { AdbClientFactory } from "./AdbClientFactory";
import { isUnknownEmulatorName } from "./emulatorReadinessEvaluation";
import type { BootedDeviceScanOptions } from "./AndroidDeviceInventoryScanner";
import { BootedDevice, ActionableError } from "../../models";
import { toActionableError } from "../../models/ActionableError";
import { logger } from "../logger";
import { raceWithDeadline } from "../raceWithDeadline";
import type { Timer } from "../SystemTimer";

export const EMULATOR_CONSOLE_KILL_BOUND_MS = 10_000;

export interface EmulatorKillOptions {
  beforeDispatch?: () => Promise<void>;
  timeoutMs?: number;
  signal?: AbortSignal;
  force?: boolean;
  processStop?: { stopper: EmulatorProcessStopper; expectedAvdName?: string };
  /** Internal absolute deadline, set before discovery. */
  deadlineMs?: number;
}

/** Members resolved through the client at call time (the other extracted units' convention). */
export interface EmulatorKillerHost {
  timer(): Timer;
  adbFactory(): AdbClientFactory;
  getBootedDevicesChecked(
    onlyEmulators: boolean,
    options: BootedDeviceScanOptions,
    signal?: AbortSignal,
  ): Promise<BootedDevice[]>;
}

/** Termination of a running emulator: console kill, process-table fallback, identity checks. */
export interface EmulatorKiller {
  killDevice(device: BootedDevice, options?: EmulatorKillOptions): Promise<BootedDevice>;
}

export class DefaultEmulatorKiller implements EmulatorKiller {
  private adbFactory(): AdbClientFactory {
    return this.host.adbFactory();
  }

  constructor(private readonly host: EmulatorKillerHost) {}

  /**
   * Request termination of the expected running emulator.
   * @param device - The device to kill
   * @param options - `force` drops the AVD-name comparison below AND the
   *   discovery that feeds it (#6864).
   * @returns The checked target after ADB accepts termination; callers confirm disappearance.
   */
  async killDevice(device: BootedDevice, options: EmulatorKillOptions = {}): Promise<BootedDevice> {
    options = { ...options, deadlineMs: this.host.timer().now() + (options.timeoutMs ?? 30_000) };
    // Under `force` the rediscovery below is serial-only. Dropping the name
    // comparison alone was not enough: enrichment runs BEFORE the comparison
    // and probes every attached emulator sequentially at 2s apiece, so three
    // wedged consoles spend 6s of a 5s forced teardown deadline inside the
    // discovery and `emu kill` is never dispatched. Since `force` has already
    // committed to killing whatever occupies this serial, every one of those
    // names is read and then discarded
    // ([#6874](https://github.com/kaeawc/auto-mobile/pull/6874) review).
    const runningEmulators = await this.discoverEmulatorsForKill(options);
    const emulator = runningEmulators.find((emu) => emu.deviceId === device.deviceId);

    if (!emulator || !emulator.deviceId) {
      return await this.killEmulatorMissingFromOnlineList(device, options);
    }

    if (emulator.platform !== device.platform) {
      throw new ActionableError(
        `Emulator '${device.deviceId}' identity changed before termination; refusing to kill its replacement.`,
      );
    }

    // `force` is the caller's decision, taken one layer up, to act on whatever
    // occupies this serial (#6864). It drops exactly the two NAME comparisons
    // below and nothing else: the serial selection above still has to find a
    // running emulator, and the termination primitive is unchanged.
    //
    // Dropping them is what makes the flag work at all. `deviceTools` reaches
    // here having deliberately NOT established an identity -- either skipping
    // the emulator-console probe whose wedging is the whole reason force
    // exists, or carrying the pooled AVD label no probe stood behind -- so a
    // second comparison against the same unanswerable discovery can only refuse
    // the forced kill on the caller's behalf a second time
    // ([#6874](https://github.com/kaeawc/auto-mobile/pull/6874) review).
    if (!options.force) {
      if (this.shouldStopMuteEmulatorProcess(device, emulator, options)) {
        await this.stopEmulatorProcess(
          device,
          options,
          new ActionableError(
            `Refusing to kill '${device.deviceId}': the emulator could not name itself.`,
          ),
        );
        return device;
      }
      if (emulator.name !== device.name) {
        throw new ActionableError(
          `Emulator '${device.deviceId}' identity changed before termination; refusing to kill its replacement.`,
        );
      }

      // Two unknowns are not an equality. `Unknown (<serial>)` on either side is
      // the absence of a name, so a request carrying the placeholder that meets a
      // discovery carrying the placeholder has matched on nothing -- and the
      // emulator answering on the serial now may be a replacement of the one the
      // caller resolved. Callers that legitimately target an emulator whose
      // console is mute resolve its AVD name first and put THAT in the target
      // (`deviceTools.confirmPooledAvdIdentity`), so reaching here with two
      // placeholders means no identity was ever established (#6863 review).
      if (
        isUnknownEmulatorName(device.name, device.deviceId) &&
        isUnknownEmulatorName(emulator.name, emulator.deviceId)
      ) {
        throw new ActionableError(
          `Refusing to kill '${device.deviceId}': the emulator could not name itself, so this ` +
            "daemon cannot tell it apart from a replacement that took the serial. Resolve its AVD " +
            (options.processStop
              ? `name and retry. ${await this.processStopEscapeHint(device, options)}`
              : `name and retry, or stop it by hand with \`adb -s ${device.deviceId} emu kill\`.`),
        );
      }
    } else {
      logger.warn(
        `[AndroidEmulatorClient] force=true: killing whatever occupies '${device.deviceId}' ` +
          `without asking the runtime to name itself and without comparing the requested AVD ` +
          `name '${device.name}' against the discovery.`,
      );
    }

    // Terminate through the emulator console `emu kill`. Only the console
    // shutdown lets the emulator write its quick-boot snapshot on exit; a guest
    // `shell reboot -p` halts the OS without it, so the next quick-boot of the
    // AVD resumes into a halted guest that never comes adb-online and burns the
    // whole getAndroid readiness budget (issue #6849 regression of #6845). The
    // console kill remains preferred; a bounded process fallback is available
    // only when the caller supplies process-table identity evidence.
    //
    // `adb emu` selects a device by serial only — the console subcommand ignores
    // `-t` and honours just `-s`/ANDROID_SERIAL, so `adb -t <id> emu kill` fails
    // with "more than one emulator detected; use -s" as soon as a second
    // emulator is attached (issue #6845). The kill is consequently always
    // serial-scoped through the discovered emulator, which is what makes it
    // correct with several emulators attached. Transport ids are not used for
    // termination at all: the serial is the kill's identity, the discovery-time
    // check above refuses a replacement AVD found on that serial, and callers
    // confirm disappearance and incarnation afterwards.
    await this.dispatchEmulatorConsoleKill(emulator, options, device);
    logger.info(`Requested termination of emulator '${device.name}'`);
    return emulator;
  }

  private async discoverEmulatorsForKill(options: EmulatorKillOptions): Promise<BootedDevice[]> {
    const discover = (signal?: AbortSignal) =>
      this.host.getBootedDevicesChecked(
        false,
        {
          bypassDeviceListCache: true,
          skipNameEnrichment: options.force === true,
        },
        signal,
      );
    if (!options.processStop) {
      return discover(options.signal);
    }
    const controller = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;
    return raceWithDeadline(() => discover(signal), {
      timer: this.host.timer(),
      signal: options.signal,
      timeoutMs: Math.max(
        0,
        (options.deadlineMs ?? this.host.timer().now()) - this.host.timer().now(),
      ),
      label: "Emulator shutdown discovery",
      onTimeout: () => controller.abort(),
    });
  }

  private async dispatchEmulatorConsoleKill(
    target: BootedDevice,
    options: EmulatorKillOptions,
    identityTarget: BootedDevice = target,
  ): Promise<void> {
    const remainingMs =
      (options.deadlineMs ?? this.host.timer().now() + (options.timeoutMs ?? 30_000)) -
      this.host.timer().now();
    const timeoutMs = options.processStop
      ? Math.max(0, Math.min(remainingMs / 3, EMULATOR_CONSOLE_KILL_BOUND_MS))
      : options.timeoutMs;
    try {
      await this.adbFactory().create(target).execute(["emu", "kill"], {
        beforeDispatch: options.beforeDispatch,
        timeoutMs,
        noRetry: true,
        signal: options.signal,
        waitForProcessSettlementAfterAbort: true,
      });
    } catch (error) {
      if (!options.processStop) {
        throw error;
      }
      options.signal?.throwIfAborted();
      if (!(error instanceof AdbCommandTimeoutError)) {
        throw error;
      }
      logger.warn(
        `[AndroidEmulatorClient] console kill timed out for ${target.deviceId}; checking process identity`,
        error,
      );
      try {
        await this.stopEmulatorProcess(identityTarget, options, error);
      } catch (stopError) {
        throw markEmulatorStopDispatched(
          stopError instanceof Error
            ? stopError
            : toActionableError(stopError, "Emulator stop failed after console kill"),
        );
      }
    }
  }

  private shouldStopMuteEmulatorProcess(
    device: BootedDevice,
    emulator: BootedDevice,
    options: EmulatorKillOptions,
  ): boolean {
    return Boolean(
      options.processStop &&
      isUnknownEmulatorName(emulator.name, emulator.deviceId) &&
      this.processStopAvdName(device, options),
    );
  }

  private processStopAvdName(
    device: BootedDevice,
    options: EmulatorKillOptions,
  ): string | undefined {
    return isUnknownEmulatorName(device.name, device.deviceId)
      ? options.processStop?.expectedAvdName
      : device.name;
  }

  private async processStopEscapeHint(
    device: BootedDevice,
    options: EmulatorKillOptions,
    identity?: EmulatorProcessIdentity,
  ): Promise<string> {
    if (identity) {
      return this.processIdentityEscapeHint(device, identity);
    }
    const stopper = options.processStop?.stopper;
    if (!stopper) {
      return emulatorProcessEscapeHint(device.deviceId);
    }
    const stopOptions = {
      deadlineMs: options.deadlineMs ?? this.host.timer().now(),
      signal: options.signal,
    };
    const described = await stopper.describeSerial(device.deviceId, stopOptions);
    if (described.kind === "read" && described.candidates.length > 0) {
      return emulatorProcessEscapeHint(device.deviceId, described.candidates);
    }
    const observed = await stopper.identify(
      { serial: device.deviceId, avdName: this.processStopAvdName(device, options) ?? "" },
      stopOptions,
    );
    return this.processIdentityEscapeHint(device, observed);
  }

  private processIdentityEscapeHint(
    device: BootedDevice,
    identity: EmulatorProcessIdentity,
  ): string {
    switch (identity.kind) {
      case "absent":
      case "unreadable":
        return emulatorProcessEscapeHint(device.deviceId, [], identity.kind);
      case "ambiguous":
        return emulatorProcessEscapeHint(device.deviceId, identity.candidates);
      default:
        return emulatorProcessEscapeHint(device.deviceId, [identity]);
    }
  }

  private async stopEmulatorProcess(
    device: BootedDevice,
    options: EmulatorKillOptions,
    refusal: Error,
  ): Promise<void> {
    const avdName = this.processStopAvdName(device, options);
    if (!options.processStop || !avdName) {
      throw await this.processStopRefusal(device, options, refusal);
    }
    const outcome = await options.processStop.stopper.stop(
      { serial: device.deviceId, avdName },
      {
        deadlineMs: options.deadlineMs ?? this.host.timer().now(),
        signal: options.signal,
      },
    );
    switch (outcome.kind) {
      case "stopped":
        return;
      case "identity-mismatch":
        throw new ActionableError(
          `Emulator '${device.deviceId}' identity changed before termination; refusing to kill its replacement (AVD '${outcome.runningAvdName}').`,
        );
      case "still-running":
        if (!outcome.signalled) {
          throw new ActionableError(
            `Emulator '${device.deviceId}' (AVD '${avdName}') is still running with pid ${outcome.pid}; no signal could be delivered (deadline spent or signal refused: permission denied or unsafe pid). ${emulatorProcessEscapeHint(device.deviceId, [{ pid: outcome.pid, command: outcome.command }])}`,
          );
        }
        throw new EmulatorStillRunningError(outcome.pid, device.deviceId, avdName, outcome.command);
      case "unidentified":
        throw await this.processStopRefusal(device, options, refusal, outcome.identity);
    }
  }

  private async processStopRefusal(
    device: BootedDevice,
    options: EmulatorKillOptions,
    refusal: Error,
    identity?: EmulatorProcessIdentity,
  ): Promise<Error> {
    const message = `${refusal.message} ${await this.processStopEscapeHint(device, options, identity)}`;
    return refusal instanceof AdbCommandTimeoutError
      ? new AdbCommandTimeoutError(message)
      : new ActionableError(message, { cause: refusal });
  }

  /**
   * The serial is not among the `device`-state rows `killDevice` rediscovered.
   * That is not proof the emulator stopped: `adb devices` also lists an
   * emulator whose transport dropped (host sleep/wake, a boot that never
   * finished) as `offline` while its process keeps running and keeps holding
   * its AVD (#10074). Read the raw states before answering "not running", so a
   * caller never retires session/pool ownership of an emulator that is alive.
   *
   * - absent from `adb devices` altogether: the one case that is "not running";
   * - attached in another state, without `force`: a distinct error that the
   *   already-stopped classifier does not match, so ownership stays intact;
   * - attached in another state, under `force`: the serial-scoped console kill.
   *   `adb emu` talks to the emulator console port rather than the adb
   *   transport, so it still reaches an `offline` emulator. Disappearance is
   *   confirmed by the caller, which must also see the serial leave `adb devices`.
   */
  private async killEmulatorMissingFromOnlineList(
    device: BootedDevice,
    options: EmulatorKillOptions,
  ): Promise<BootedDevice> {
    const stateOptions = options.processStop
      ? {
          ...options,
          timeoutMs: Math.max(
            0,
            (options.deadlineMs ?? this.host.timer().now()) - this.host.timer().now(),
          ),
        }
      : options;
    const attachedState = await this.readAttachedStateForKill(device, stateOptions);
    if (attachedState === undefined) {
      return await this.killEmulatorAbsentFromAdb(device, options);
    }
    const label = this.emulatorLabel(device);
    if (!options.force) {
      throw new ActionableError(
        `Emulator '${label}' (${device.deviceId}) is attached to adb but reported in state ` +
          `'${attachedState}', so the daemon cannot tell whether it has stopped and has left its ` +
          `session and pool entry untouched. Retry killDevice with force: true to send the ` +
          `emulator console kill to ${device.deviceId} anyway.`,
      );
    }
    logger.warn(
      `[AndroidEmulatorClient] force=true: '${device.deviceId}' is attached in adb state ` +
        `'${attachedState}'; dispatching the console kill without a booted-device match.`,
    );
    await this.dispatchEmulatorConsoleKill(device, options);
    logger.info(`Requested termination of emulator '${label}' (adb state '${attachedState}')`);
    return device;
  }

  /** The AVD name, or the serial when the caller's target carries no usable name. */
  private emulatorLabel(device: BootedDevice): string {
    return device.name.trim() === "" ? device.deviceId : device.name;
  }

  /**
   * adb lists no row for the serial. That only proves the daemon's adb server does not know
   * it, not that the emulator exited: the emulator process can outlive its adb registration
   * (a different adb server, a dropped transport). The process table is the second witness;
   * only when it also has no process for the serial is the emulator "not running".
   */
  private async killEmulatorAbsentFromAdb(
    device: BootedDevice,
    options: EmulatorKillOptions,
  ): Promise<BootedDevice> {
    const stopper = options.processStop?.stopper;
    const described = stopper
      ? await stopper.describeSerial(device.deviceId, {
          deadlineMs: options.deadlineMs ?? this.host.timer().now(),
          signal: options.signal,
        })
      : ({ kind: "read", candidates: [] } satisfies EmulatorSerialDescription);
    if (described.kind === "unreadable") {
      // Fail closed: an unreadable table (ps failure, deadline, unsupported platform) cannot
      // prove absence, and this wording must not match the already-stopped classifier.
      throw new ActionableError(
        `Cannot confirm whether emulator '${this.emulatorLabel(device)}' (${device.deviceId}) has ` +
          `stopped: adb does not list it and the host process table could not be read ` +
          `(${described.detail}), so its session and pool entry were left untouched. ` +
          emulatorProcessEscapeHint(device.deviceId, [], "unreadable"),
      );
    }
    const { candidates } = described;
    if (candidates.length === 0) {
      throw new ActionableError(`Emulator '${this.emulatorLabel(device)}' is not running`);
    }
    const label = this.emulatorLabel(device);
    if (this.processStopAvdName(device, options)) {
      logger.warn(
        `[AndroidEmulatorClient] '${device.deviceId}' is absent from adb but its emulator process is ` +
          `alive; stopping it through the process table.`,
      );
      await this.stopEmulatorProcess(
        device,
        options,
        new ActionableError(`Emulator '${label}' is absent from adb`),
      );
      return device;
    }
    throw new ActionableError(
      `Emulator '${label}' (${device.deviceId}) has a live process but adb does not list it, and ` +
        `no AVD name was given to verify its identity. ${emulatorProcessEscapeHint(device.deviceId, candidates)}`,
    );
  }

  private async readAttachedStateForKill(
    device: BootedDevice,
    options: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<string | undefined> {
    const adb = this.adbFactory().create(null);
    if (!adb.getDeviceStates) {
      return undefined;
    }
    try {
      const states = await adb.getDeviceStates({
        timeoutMs: options.timeoutMs,
        signal: options.signal,
        // A vanished adb cannot say the serial is gone either (#11643).
        throwOnMissingAdb: true,
      });
      return states.find((state) => state.deviceId === device.deviceId)?.state;
    } catch (error) {
      if (options.signal?.aborted) {
        throw error;
      }
      // An unreadable state list cannot prove the serial is gone, so fail the kill
      // rather than let the caller classify the emulator as already stopped.
      throw toActionableError(
        error,
        `Could not read adb device states to confirm '${device.deviceId}' is stopped`,
      );
    }
  }
}
