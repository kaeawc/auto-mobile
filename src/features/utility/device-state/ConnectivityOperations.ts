import type { BootedDevice } from "../../../models";
import type { AdbClientFactory } from "../../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { outputLooksLikeShellFailure } from "../../../utils/android-cmdline-tools/shellOutputHeuristics";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import { wifiToggleCommand } from "./NetworkConditionState";
import {
  ANDROID_CONNECTIVITY_READS,
  ANDROID_CONNECTIVITY_READ_COMMAND,
  IOS_CONNECTIVITY_UNSUPPORTED_ERROR,
  IOS_CONNECTIVITY_WRITE_UNSUPPORTED_ERROR,
  decodeAndroidConnectivityValue,
  parseAndroidConnectivityOutput,
  type DeviceConnectivityField,
  type DeviceConnectivityState,
  type SetDeviceConnectivityInput,
} from "./ConnectivityState";

interface ConnectivityOperationsDependencies {
  device: () => BootedDevice;
  adbFactory: () => AdbClientFactory;
}

export class ConnectivityOperations {
  constructor(private readonly dependencies: ConnectivityOperationsDependencies) {}

  /** Platform dispatch for reading the device-level connectivity toggles. */
  async readConnectivity(): Promise<DeviceConnectivityState> {
    return this.dependencies.device().platform === "android"
      ? this.getAndroidConnectivity()
      : { supported: false, error: IOS_CONNECTIVITY_UNSUPPORTED_ERROR };
  }

  /** Platform dispatch for writing device-level connectivity toggles. */
  writeConnectivity(input: SetDeviceConnectivityInput): Promise<DeviceConnectivityState> {
    return this.dependencies.device().platform === "android"
      ? this.setAndroidConnectivity(input)
      : Promise.resolve({
          supported: false,
          verified: false,
          error: IOS_CONNECTIVITY_WRITE_UNSUPPORTED_ERROR,
        });
  }

  /**
   * Read airplane/Wi-Fi/Bluetooth/location in a single adb round-trip
   * (issue #6872). Failure policy, per field:
   * - one key absent or malformed -> that field is `undefined`, siblings keep
   *   their values, and the unreadable names go into `warning`;
   * - NOTHING parsed -> an `error`, because the device answered nothing usable
   *   and silently reporting four `undefined`s would look like a clean read;
   * - the command threw -> an `error` carrying the underlying message.
   */
  private async getAndroidConnectivity(): Promise<DeviceConnectivityState> {
    let stdout: string;
    try {
      const adb = this.dependencies.adbFactory().create(this.dependencies.device());
      const result = await adb.executeCommand(
        ANDROID_CONNECTIVITY_READ_COMMAND,
        undefined,
        undefined,
        true,
      );
      stdout = result.stdout;
    } catch (error) {
      // Strategy 2: log, then return a typed failure — the tool reports the
      // error to the client instead of throwing out of a read-only state dump.
      logger.warn(`[DeviceState] connectivity read failed: ${errorMessage(error)}`, error);
      return {
        supported: true,
        method: "android_settings_batch",
        error: errorMessage(error),
      };
    }

    const rawValues = parseAndroidConnectivityOutput(stdout);
    const parsed: Partial<Record<DeviceConnectivityField, boolean>> = {};
    const unreadable: DeviceConnectivityField[] = [];
    for (const read of ANDROID_CONNECTIVITY_READS) {
      const value = decodeAndroidConnectivityValue(read.shape, rawValues[read.field]);
      if (value === undefined) {
        unreadable.push(read.field);
      } else {
        parsed[read.field] = value;
      }
    }

    const base = {
      supported: true as const,
      method: "android_settings_batch" as const,
      ...parsed,
      ...(Object.keys(rawValues).length > 0 ? { rawValues } : {}),
    };
    if (unreadable.length === ANDROID_CONNECTIVITY_READS.length) {
      return {
        ...base,
        error: `Could not read any Android connectivity toggles (${unreadable.join(", ")}).`,
      };
    }
    if (unreadable.length > 0) {
      return {
        ...base,
        warning: `Could not read: ${unreadable.join(", ")}. Absent or unparsable on this device.`,
      };
    }
    return base;
  }

  /**
   * Set requested Android connectivity toggles to their desired end states.
   * The initial batched read makes already-achieved requests no-ops; a fresh
   * read after writes is the source of the returned state and verification.
   */
  private async setAndroidConnectivity(
    input: SetDeviceConnectivityInput,
  ): Promise<DeviceConnectivityState> {
    const requestedFields = ANDROID_CONNECTIVITY_READS.map((read) => read.field).filter(
      (field) => input[field] !== undefined,
    );
    const before = await this.getAndroidConnectivity();
    const fieldsToWrite = requestedFields.filter((field) => before[field] !== input[field]);

    if (fieldsToWrite.length === 0) {
      return { ...before, verified: true };
    }

    const writes = await this.applyAndroidConnectivityWrites(fieldsToWrite, input);
    return this.withConnectivityVerification(
      writes.wrote ? await this.getAndroidConnectivity() : before,
      input,
      requestedFields,
      writes.failedFields,
    );
  }

  /** Apply every needed connectivity write without letting one failed radio block its siblings. */
  private async applyAndroidConnectivityWrites(
    fieldsToWrite: readonly DeviceConnectivityField[],
    input: SetDeviceConnectivityInput,
  ): Promise<{ wrote: boolean; failedFields: Set<DeviceConnectivityField> }> {
    let adb: AdbExecutor;
    try {
      adb = this.dependencies.adbFactory().create(this.dependencies.device());
    } catch (error) {
      logger.warn(
        `[DeviceState] connectivity writer creation failed: ${errorMessage(error)}`,
        error,
      );
      return { wrote: false, failedFields: new Set() };
    }

    const failedFields = new Set<DeviceConnectivityField>();
    for (const field of fieldsToWrite) {
      if (await this.applyAndroidConnectivityField(adb, field, input[field]!)) {
        failedFields.add(field);
      }
    }
    return { wrote: true, failedFields };
  }

  /** Log a typed, best-effort failure and continue with the other requested toggles. */
  private async applyAndroidConnectivityField(
    adb: AdbExecutor,
    field: DeviceConnectivityField,
    enabled: boolean,
  ): Promise<boolean> {
    try {
      const commandError = await this.setAndroidConnectivityField(adb, field, enabled);
      if (commandError) {
        logger.warn(`[DeviceState] connectivity write for ${field} failed: ${commandError}`);
        return true;
      }
      return false;
    } catch (error) {
      // A failed toggle must not prevent the other requested desired states from applying.
      logger.warn(
        `[DeviceState] connectivity write for ${field} failed: ${errorMessage(error)}`,
        error,
      );
      return true;
    }
  }

  /** Build a verified write result from the state freshly read from Android. */
  private withConnectivityVerification(
    state: DeviceConnectivityState,
    input: SetDeviceConnectivityInput,
    requestedFields: readonly DeviceConnectivityField[],
    failedFields: ReadonlySet<DeviceConnectivityField>,
  ): DeviceConnectivityState {
    const unverified = requestedFields.filter(
      (field) => failedFields.has(field) || state[field] !== input[field],
    );
    if (unverified.length === 0) {
      return { ...state, verified: true };
    }
    const verificationWarning = `Could not verify requested connectivity state: ${unverified.join(
      ", ",
    )}.`;
    return {
      ...state,
      verified: false,
      warning: [state.warning, verificationWarning].filter(Boolean).join(" "),
    };
  }

  /** Execute the Android commands for one connectivity field, returning a shell failure message. */
  private async setAndroidConnectivityField(
    adb: AdbExecutor,
    field: DeviceConnectivityField,
    enabled: boolean,
  ): Promise<string | undefined> {
    switch (field) {
      case "wifiEnabled":
        return this.runAndroidConnectivityCommand(adb, wifiToggleCommand(!enabled));
      case "bluetoothEnabled":
        return this.runAndroidConnectivityCommand(
          adb,
          `shell svc bluetooth ${enabled ? "enable" : "disable"}`,
        );
      case "airplaneMode":
        return this.runAndroidConnectivityCommand(
          adb,
          `shell cmd connectivity airplane-mode ${enabled ? "enable" : "disable"}`,
        );
      case "locationEnabled":
        return this.setAndroidLocationEnabled(adb, enabled);
    }
  }

  /** Prefer the API-31 location command, then fall back to the legacy secure setting. */
  private async setAndroidLocationEnabled(
    adb: AdbExecutor,
    enabled: boolean,
  ): Promise<string | undefined> {
    const primaryCommand = `shell cmd location set-location-enabled ${enabled}`;
    try {
      const primaryError = await this.runAndroidConnectivityCommand(adb, primaryCommand);
      if (!primaryError) {
        return undefined;
      }
      logger.debug(
        `[DeviceState] location command '${primaryCommand}' reported '${primaryError}'; falling back`,
      );
    } catch (error) {
      logger.debug(
        `[DeviceState] location command '${primaryCommand}' failed: ${errorMessage(error)}; falling back`,
      );
    }
    return this.runAndroidConnectivityCommand(
      adb,
      `shell settings put secure location_mode ${enabled ? "3" : "0"}`,
    );
  }

  /** Return a shell-reported failure without turning an expected writer failure into a throw. */
  private async runAndroidConnectivityCommand(
    adb: AdbExecutor,
    command: string,
  ): Promise<string | undefined> {
    const result = await adb.executeCommand(command, undefined, undefined, true);
    const stdout = result.stdout;
    const stderr = result.stderr ?? "";
    return outputLooksLikeShellFailure(stdout, stderr)
      ? `${stdout}\n${stderr}`.trim() || `${command} reported an error`
      : undefined;
  }
}
