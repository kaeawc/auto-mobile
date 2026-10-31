import type { BootedDevice } from "../../../models";
import type { AdbClientFactory } from "../../../utils/android-cmdline-tools/AdbClientFactory";
import type { DeviceTraits } from "../../../utils/android-cmdline-tools/deviceTraits";
import { getRequestContext } from "../../../utils/AbortContext";
import { exponentialBackoff, type BackoffPolicy } from "../../../utils/Backoff";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import type { Timer } from "../../../utils/SystemTimer";
import {
  defaultPowerClientFactory,
  type PowerClientFactory,
  type PowerDeviceClient,
} from "./AndroidPowerClient";
import { POWER_MIN_API, powerRefusal, type PowerTarget } from "./PowerPlan";
import { defaultPowerRegistry, type PowerRegistry, type SessionPower } from "./PowerRegistry";
import { settleDoze, type DozeSettlement } from "./PowerSettle";
import { buildPowerSteps, type PowerStep } from "./PowerSteps";
import { verifyRequested } from "./PowerVerify";
import {
  POWER_BASELINE_UNREADABLE,
  POWER_COMMAND_FAILED,
  POWER_DOZE_UNAVAILABLE,
  POWER_UNSUPPORTED_ERROR,
  type PowerErrorCode,
  type PowerField,
  type PowerState,
  type SetPowerInput,
  type StandbyReading,
} from "./PowerTypes";

/** Runs a power write with the id of the session that owns it (none when sessionless). */
export type PowerMutation = (
  mutation: (owner: string | undefined) => Promise<PowerState>,
) => Promise<PowerState>;

interface DozeSettleOptions {
  backoff?: BackoffPolicy;
  defaultBudgetMs?: number;
}

export interface PowerOperationsDependencies {
  settle?: DozeSettleOptions;
  device: () => BootedDevice;
  clientFactory: () => PowerClientFactory;
  registry: () => PowerRegistry;
  traits: () => Promise<PowerTarget>;
  timer: () => Pick<Timer, "sleep" | "now">;
  mutation: () => PowerMutation;
}

/** The power seams `DeviceState` accepts; each defaults to the production one. */
export interface PowerDeviceStateDependencies {
  settle?: DozeSettleOptions;
  clientFactory?: PowerClientFactory;
  registry?: PowerRegistry;
  /** Emulator and API-level lookup; defaults to the shared build-prop reader. */
  target?: () => Promise<PowerTarget>;
  /** Session admission and ownership for a write; sessionless when absent. */
  mutation?: PowerMutation;
}

/** Build the operations `DeviceState` drives, resolving device, adb and traits lazily. */
export function createPowerOperations(
  device: () => BootedDevice,
  adbFactory: () => AdbClientFactory,
  deviceTraits: () => DeviceTraits,
  {
    timer,
    seams = {},
  }: { timer: () => Pick<Timer, "sleep" | "now">; seams?: PowerDeviceStateDependencies },
): PowerOperations {
  return new PowerOperations({
    device,
    settle: seams.settle,
    clientFactory: () => seams.clientFactory ?? defaultPowerClientFactory(adbFactory()),
    registry: () => seams.registry ?? defaultPowerRegistry,
    traits:
      seams.target ??
      (async () => {
        const traits = await deviceTraits().read(adbFactory().create(device()), device().deviceId);
        return { isEmulator: traits.isEmulator === true, sdk: traits.sdk };
      }),
    timer,
    mutation: () => seams.mutation ?? ((mutation) => mutation(undefined)),
  });
}

interface Failure {
  code: PowerErrorCode;
  message: string;
}

const SESSIONLESS_WARNING =
  "No session owns this change, so nothing restores it automatically: undo it with " +
  "battery.reset, doze off, batterySaver/dataSaver false, thermalStatus reset and the " +
  "restoreReceipt values when done. doze off does not replug a charger an earlier doze call " +
  "unplugged: follow it with battery.reset or the receipt's battery.charging.";

function refused(code: PowerErrorCode, message: string): PowerState {
  return { supported: true, verified: false, errorCode: code, error: message };
}

/**
 * Battery, battery saver, Doze, App Standby, Data Saver and thermal status for Android (#14084).
 * Each field's prior value is read before the first change and kept (in memory, per device) so
 * a session's release can put it back; every write returns that prior value as a restore receipt.
 */
export class PowerOperations {
  constructor(private readonly dependencies: PowerOperationsDependencies) {}

  async read(): Promise<PowerState> {
    const device = this.dependencies.device();
    if (device.platform !== "android") {
      return { supported: false, error: POWER_UNSUPPORTED_ERROR };
    }
    const sdk = (await this.target()).sdk;
    return this.snapshot(this.client(), sdk, this.trackedApps(device.deviceId));
  }

  write(input: SetPowerInput): Promise<PowerState> {
    const device = this.dependencies.device();
    if (device.platform !== "android") {
      return Promise.resolve({ supported: false, verified: false, error: POWER_UNSUPPORTED_ERROR });
    }
    return this.dependencies.mutation()((owner) => this.apply(input, owner));
  }

  private client(): PowerDeviceClient {
    return this.dependencies.clientFactory()(this.dependencies.device());
  }

  private async target(): Promise<PowerTarget> {
    try {
      return await this.dependencies.traits();
    } catch (error) {
      // Without build props the API gates are not applied; the device commands still fail typed.
      logger.warn(`[power] Could not read device build props: ${errorMessage(error)}`, error);
      return { isEmulator: false, sdk: null };
    }
  }

  private trackedApps(deviceId: string): string[] {
    const baseline = this.dependencies.registry().get(deviceId)?.baseline;
    return [
      ...new Set([
        ...Object.keys(baseline?.standby ?? {}),
        ...Object.keys(baseline?.inactive ?? {}),
      ]),
    ];
  }

  private async apply(input: SetPowerInput, owner: string | undefined): Promise<PowerState> {
    const device = this.dependencies.device();
    const target = await this.target();
    const refusal = powerRefusal(input, target);
    if (refusal) {
      return refused(refusal.code, refusal.message);
    }
    const client = this.client();
    const dozeProblem = await this.dozeUnavailable(input, client);
    if (dozeProblem) {
      return refused(POWER_DOZE_UNAVAILABLE, dozeProblem);
    }
    const registry = this.dependencies.registry();
    const hadRecord = registry.get(device.deviceId) !== undefined;
    const record: SessionPower = owner
      ? registry.ensure(device.deviceId, owner)
      : { deviceId: device.deviceId, sessionId: "", baseline: {}, changed: [] };
    const preconditions: string[] = [];
    const steps = buildPowerSteps(input, {
      client,
      record,
      timer: this.dependencies.timer(),
      preconditions,
    });
    const { applied, failures } = await this.runSteps(steps, record);
    if (owner && !hadRecord && record.changed.length === 0) {
      registry.forget(device.deviceId);
    }
    const after = await this.snapshot(client, target.sdk, [
      ...new Set(
        [
          input.standbyBucket?.appId,
          input.appInactive?.appId,
          ...this.trackedApps(device.deviceId),
        ].filter((id): id is string => id !== undefined),
      ),
    ]);
    const unsettled = failures.length === 0 ? await this.settle(input, after, client) : undefined;
    return this.result(input, {
      after,
      applied,
      failures,
      preconditions,
      record,
      owner,
      unsettled,
    });
  }

  private async settle(
    input: SetPowerInput,
    after: PowerState,
    client: PowerDeviceClient,
  ): Promise<DozeSettlement | undefined> {
    if (!input.doze || !after.doze || after.doze.mode === input.doze) {
      return undefined;
    }
    const timer = this.dependencies.timer();
    const options = this.dependencies.settle ?? {};
    const deadline = getRequestContext()?.getDeadlineMs?.();
    // Half of what the request has left, never more than the default ceiling: a long
    // deadline must not hold the power lock for minutes on a device that stays in Doze.
    const ceilingMs = options.defaultBudgetMs ?? 15_000;
    const budgetMs =
      deadline === undefined
        ? ceilingMs
        : Math.min(ceilingMs, Math.max(0, Math.floor((deadline - timer.now()) / 2)));
    const settlement = await settleDoze(client, input.doze, {
      timer,
      budgetMs,
      backoff:
        options.backoff ??
        exponentialBackoff({
          initialDelayMs: 250,
          multiplier: 2,
          maxDelayMs: 2000,
        }),
      reading: after.doze,
    });
    after.doze = settlement.reading;
    return !settlement.settled && settlement.waitedMs >= budgetMs ? settlement : undefined;
  }

  /** Deep or light Doze can be turned off by the build; say so before touching anything. */
  private async dozeUnavailable(
    input: SetPowerInput,
    client: PowerDeviceClient,
  ): Promise<string | undefined> {
    if (input.doze !== "light" && input.doze !== "deep") {
      return undefined;
    }
    try {
      const enabled =
        input.doze === "deep"
          ? await client.isDeepDozeEnabled()
          : await client.isLightDozeEnabled();
      return enabled
        ? undefined
        : `${POWER_DOZE_UNAVAILABLE}: ${input.doze} Doze is disabled on this device (dumpsys deviceidle enabled ${input.doze} is 0).`;
    } catch (error) {
      logger.warn(
        `[power] Could not tell whether ${input.doze} Doze is enabled: ${errorMessage(error)}`,
        error,
      );
      return undefined;
    }
  }

  private async runSteps(
    steps: PowerStep[],
    record: SessionPower,
  ): Promise<{ applied: PowerField[]; failures: Failure[] }> {
    const applied: PowerField[] = [];
    const failures: Failure[] = [];
    const blocked = new Set<string>();
    for (const step of steps) {
      if (step.group && blocked.has(step.group)) {
        continue;
      }
      const failure = await this.runStep(step, record);
      if (failure) {
        failures.push(failure);
        if (step.group) {
          blocked.add(step.group);
        }
      } else if (!applied.includes(step.field)) {
        applied.push(step.field);
      }
    }
    return { applied, failures };
  }

  private async runStep(step: PowerStep, record: SessionPower): Promise<Failure | undefined> {
    try {
      await step.capture();
    } catch (error) {
      // Refuse rather than change a value there would be no way to put back.
      logger.warn(
        `[power] Could not read ${step.field} before changing it: ${errorMessage(error)}`,
        error,
      );
      return {
        code: POWER_BASELINE_UNREADABLE,
        message: `${POWER_BASELINE_UNREADABLE}: could not read ${step.field} before changing it, so release could not restore it (${errorMessage(error)}). Nothing was changed for it.`,
      };
    }
    // Recorded before the write: a write that half-applies is still restored.
    if (!record.changed.includes(step.field)) {
      record.changed.push(step.field);
    }
    try {
      await step.run();
      return undefined;
    } catch (error) {
      logger.warn(`[power] Changing ${step.field} failed: ${errorMessage(error)}`, error);
      return {
        code: POWER_COMMAND_FAILED,
        message: `${POWER_COMMAND_FAILED}: changing ${step.field} failed: ${errorMessage(error)}`,
      };
    }
  }

  private result(
    input: SetPowerInput,
    run: {
      after: PowerState;
      applied: PowerField[];
      failures: Failure[];
      preconditions: string[];
      record: SessionPower;
      owner: string | undefined;
      unsettled?: DozeSettlement;
    },
  ): PowerState {
    const { after, failures, record, owner } = run;
    const mismatches = failures.length > 0 ? [] : verifyRequested(input, after, run.unsettled);
    return {
      ...after,
      applied: run.applied,
      ...(run.preconditions.length > 0 ? { preconditions: run.preconditions } : {}),
      restoreReceipt: structuredClone(record.baseline),
      restoreOnRelease: owner !== undefined,
      verified: failures.length === 0 && mismatches.length === 0,
      ...(mismatches.length > 0 ? { mismatches } : {}),
      ...(failures[0] ? { errorCode: failures[0].code } : {}),
      ...(failures.length > 0
        ? { error: failures.map((failure) => failure.message).join("; ") }
        : {}),
      ...(owner === undefined ? { warning: SESSIONLESS_WARNING } : {}),
    };
  }

  /** Read every control; a probe that fails is listed as unreadable rather than failing the read. */
  private async snapshot(
    client: PowerDeviceClient,
    sdk: number | null,
    appIds: string[],
  ): Promise<PowerState> {
    const unreadable: string[] = [];
    const attempt = async <T>(name: string, minApi: number, read: () => Promise<T>) => {
      if (sdk !== null && sdk < minApi) {
        return undefined;
      }
      try {
        return await read();
      } catch (error) {
        logger.warn(`[power] Could not read ${name}: ${errorMessage(error)}`, error);
        unreadable.push(name);
        return undefined;
      }
    };
    const battery = await attempt("battery", 0, () => client.readBattery());
    const doze = await attempt("doze", POWER_MIN_API.doze, () => client.readDoze());
    const batterySaver = await attempt("batterySaver", POWER_MIN_API.batterySaver, () =>
      client.readBatterySaver(),
    );
    const dataSaver = await attempt("dataSaver", POWER_MIN_API.dataSaver, () =>
      client.readDataSaver(),
    );
    const thermal = await attempt("thermal", POWER_MIN_API.thermal, () => client.readThermal());
    const standby = await Promise.all(
      appIds.map(async (appId): Promise<StandbyReading> => {
        const bucket = await attempt(`standby ${appId}`, POWER_MIN_API.standbyBucket, () =>
          client.readStandbyBucket(appId),
        );
        const inactive = await attempt(`inactive ${appId}`, POWER_MIN_API.appInactive, () =>
          client.readInactive(appId),
        );
        return {
          appId,
          ...(bucket ? { bucket } : {}),
          ...(inactive === undefined ? {} : { inactive }),
        };
      }),
    );
    return {
      supported: true,
      ...(battery ? { battery } : {}),
      ...(doze ? { doze } : {}),
      ...(batterySaver === undefined ? {} : { batterySaver }),
      ...(dataSaver === undefined ? {} : { dataSaver }),
      ...(thermal ? { thermal } : {}),
      ...(standby.length > 0 ? { standby } : {}),
      ...(unreadable.length > 0 ? { unreadable } : {}),
    };
  }
}
