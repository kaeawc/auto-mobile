import { exponentialBackoff, type BackoffPolicy } from "../../../utils/Backoff";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import type { Timer } from "../../../utils/SystemTimer";
import type { PowerDeviceClient } from "./AndroidPowerClient";
import type { SessionPower } from "./PowerRegistry";
import { settleDoze } from "./PowerSettle";
import {
  STANDBY_BUCKETS,
  type PowerField,
  type PowerFieldRestoreReport,
  type PowerRestoreReport,
  type StandbyBucket,
} from "./PowerTypes";

const RESTORE_ATTEMPTS = 2;
const RESTORE_RETRY_DELAY_MS = 1_000;
/** How long a restored Doze mode may take to show in deviceidle before it counts as a mismatch. */
const DOZE_RESTORE_SETTLE_MS = 3_000;

export interface PowerRestoreDependencies {
  timer: Pick<Timer, "sleep" | "now">;
  /** Delays between Doze read-backs while deviceidle settles (#15042). */
  dozeBackoff?: BackoffPolicy;
}

/** One field's restore: the write, then a fresh read that must match the baseline. */
interface FieldRestore {
  apply: () => Promise<void>;
  /** True when the device now matches the baseline. */
  verify: () => Promise<boolean>;
  /** Why this field cannot be restored, when it cannot. */
  skip?: string;
}

function isSettableBucket(value: string): value is StandbyBucket {
  return (STANDBY_BUCKETS as readonly string[]).includes(value);
}

function batteryRestore(record: SessionPower, client: PowerDeviceClient): FieldRestore {
  const before = record.baseline.battery;
  if (!before?.faked) {
    // Nothing faked it before this session: hand the real values back.
    return {
      apply: () => client.resetBattery(),
      verify: async () => !(await client.readBattery()).faked,
    };
  }
  return {
    apply: async () => {
      await client.setBatteryCharging(before.charging);
      await client.setBatteryLevel(before.level);
    },
    verify: async () => {
      const now = await client.readBattery();
      return now.level === before.level && now.charging === before.charging;
    },
  };
}

function dozeRestore(
  record: SessionPower,
  client: PowerDeviceClient,
  dependencies: PowerRestoreDependencies,
): FieldRestore {
  const mode = record.baseline.doze ?? "off";
  return {
    apply: async () => {
      await client.unforceDoze();
      if (mode !== "off") {
        await client.forceDoze(mode);
      }
    },
    // deviceidle can report the forced state for a moment after unforce: poll before failing.
    verify: async () => {
      const settlement = await settleDoze(client, mode, {
        timer: dependencies.timer,
        budgetMs: DOZE_RESTORE_SETTLE_MS,
        backoff:
          dependencies.dozeBackoff ??
          exponentialBackoff({ initialDelayMs: 250, multiplier: 2, maxDelayMs: 1_000 }),
        reading: await client.readDoze(),
      });
      return settlement.settled;
    },
  };
}

function thermalRestore(record: SessionPower, client: PowerDeviceClient): FieldRestore {
  const before = record.baseline.thermal;
  return {
    apply: () => (before?.override ? client.overrideThermal(before.status) : client.resetThermal()),
    verify: async () => {
      const now = await client.readThermal();
      return before?.override ? now.override && now.status === before.status : !now.override;
    },
  };
}

function batterySaverRestore(record: SessionPower, client: PowerDeviceClient): FieldRestore {
  // Unset (null) goes back to off: there is no unset verb in `settings put`.
  const enabled = record.baseline.batterySaver === true;
  return {
    apply: () => client.setBatterySaver(enabled),
    verify: async () => ((await client.readBatterySaver()) ?? false) === enabled,
  };
}

function dataSaverRestore(record: SessionPower, client: PowerDeviceClient): FieldRestore {
  const enabled = record.baseline.dataSaver === true;
  return {
    apply: () => client.setDataSaver(enabled),
    verify: async () => (await client.readDataSaver()) === enabled,
  };
}

function standbyRestore(record: SessionPower, client: PowerDeviceClient): FieldRestore {
  const entries = Object.entries(record.baseline.standby ?? {});
  const unsettable = entries.filter(([, bucket]) => !isSettableBucket(bucket));
  const settable = entries.filter((entry): entry is [string, StandbyBucket] =>
    isSettableBucket(entry[1]),
  );
  return {
    skip:
      settable.length === 0 && unsettable.length > 0
        ? `A shell cannot set a ${unsettable.map(([app, bucket]) => `${app} (${bucket})`).join(", ")} bucket back.`
        : undefined,
    apply: async () => {
      for (const [appId, bucket] of settable) {
        await client.setStandbyBucket(appId, bucket);
      }
    },
    verify: async () => {
      const reads = await Promise.all(
        settable.map(async ([appId, bucket]) => (await client.readStandbyBucket(appId)) === bucket),
      );
      return reads.every(Boolean);
    },
  };
}

function inactiveRestore(record: SessionPower, client: PowerDeviceClient): FieldRestore {
  const entries = Object.entries(record.baseline.inactive ?? {});
  return {
    apply: async () => {
      for (const [appId, inactive] of entries) {
        await client.setInactive(appId, inactive);
      }
    },
    verify: async () => {
      const reads = await Promise.all(
        entries.map(async ([appId, inactive]) => (await client.readInactive(appId)) === inactive),
      );
      return reads.every(Boolean);
    },
  };
}

function screenRestore(client: PowerDeviceClient): FieldRestore {
  return {
    apply: () => client.wakeScreen(),
    verify: () => client.isScreenOn(),
  };
}

function fieldRestore(
  field: PowerField,
  record: SessionPower,
  client: PowerDeviceClient,
  dependencies: PowerRestoreDependencies,
): FieldRestore | undefined {
  switch (field) {
    case "battery":
      return batteryRestore(record, client);
    case "screen":
      return record.screenSlept ? screenRestore(client) : undefined;
    case "doze":
      return dozeRestore(record, client, dependencies);
    case "batterySaver":
      return batterySaverRestore(record, client);
    case "dataSaver":
      return dataSaverRestore(record, client);
    case "thermal":
      return thermalRestore(record, client);
    case "standby":
      return standbyRestore(record, client);
    case "inactive":
      return inactiveRestore(record, client);
  }
}

async function runFieldRestore(
  field: PowerField,
  restore: FieldRestore,
  dependencies: PowerRestoreDependencies,
): Promise<PowerFieldRestoreReport> {
  if (restore.skip) {
    return { field, status: "skipped", error: restore.skip };
  }
  let lastError = "";
  for (let attempt = 1; attempt <= RESTORE_ATTEMPTS; attempt++) {
    try {
      await restore.apply();
      const matches = await readBack(field, restore);
      if (matches !== false) {
        return { field, status: "restored", ...(matches === true ? { verified: true } : {}) };
      }
      lastError = "the device still differs from the value read before the session's change";
    } catch (error) {
      lastError = errorMessage(error);
      logger.warn(`[power] Restoring ${field} failed (attempt ${attempt}): ${lastError}`, error);
    }
    if (attempt < RESTORE_ATTEMPTS) {
      await dependencies.timer.sleep(RESTORE_RETRY_DELAY_MS);
    }
  }
  return { field, status: "failed", error: lastError };
}

/** `undefined`: the read-back itself failed, which says nothing about the device. */
async function readBack(field: PowerField, restore: FieldRestore): Promise<boolean | undefined> {
  try {
    return await restore.verify();
  } catch (error) {
    // The write succeeded; an unreadable confirmation is reported as unverified, not failed.
    logger.warn(`[power] Could not read back restored ${field}: ${errorMessage(error)}`, error);
    return undefined;
  }
}

function leftoverFor(record: SessionPower, failed: PowerField[]): string {
  const serial = record.deviceId;
  const hints: Record<PowerField, string> = {
    battery: "dumpsys battery reset",
    screen: "input keyevent KEYCODE_WAKEUP",
    doze: "dumpsys deviceidle unforce",
    batterySaver: "settings put global low_power 0",
    dataSaver: "cmd netpolicy set restrict-background false",
    thermal: "cmd thermalservice reset",
    standby: "am set-standby-bucket <appId> <bucket>",
    inactive: "am set-inactive <appId> false",
  };
  return (
    `Device ${serial} may still carry power state session ${record.sessionId} changed: ` +
    failed.map((field) => `${field} (adb -s ${serial} shell ${hints[field]})`).join("; ") +
    ". Fix it with those commands or setDeviceState power."
  );
}

/**
 * Put back what a released session changed, newest change first (so Doze is left before the
 * battery is replugged). Best effort per field: one failing field never stops the others. Never
 * throws; failures become a `partial` or `failed` report the release result carries.
 */
export async function restoreSessionPower(
  record: SessionPower,
  client: PowerDeviceClient,
  dependencies: PowerRestoreDependencies,
): Promise<PowerRestoreReport> {
  const fields: PowerFieldRestoreReport[] = [];
  for (const field of [...record.changed].reverse()) {
    const restore = fieldRestore(field, record, client, dependencies);
    if (restore) {
      fields.push(await runFieldRestore(field, restore, dependencies));
    }
  }
  const failed = fields.filter((report) => report.status === "failed");
  const restored = fields.filter((report) => report.status === "restored");
  const status =
    failed.length === 0
      ? restored.length > 0
        ? "restored"
        : "skipped"
      : restored.length > 0
        ? "partial"
        : "failed";
  if (failed.length > 0) {
    logger.warn(
      `[power] Session ${record.sessionId} left ${failed.map((report) => report.field).join(", ")} changed on ${record.deviceId}`,
    );
  }
  return {
    status,
    deviceId: record.deviceId,
    fields,
    ...(failed.length > 0
      ? {
          leftover: leftoverFor(
            record,
            failed.map((report) => report.field),
          ),
        }
      : {}),
  };
}
