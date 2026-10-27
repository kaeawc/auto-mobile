import type { BootedDevice } from "../../../models";
import type { AdbClientFactory } from "../../../utils/android-cmdline-tools/AdbClientFactory";
import {
  defaultLockSettingsClientFactory,
  type LockSettingsClient,
  type LockSettingsClientFactory,
  type LockSettingsReading,
} from "./AndroidLockSettings";
import {
  defaultScreenLockRegistry,
  type ScreenLockRegistry,
  type SessionScreenLock,
} from "./ScreenLockRegistry";
import { defaultForgetRememberedUnlock, type ForgetRememberedUnlock } from "./ScreenLockRestore";
import {
  LOCK_CREDENTIAL_MISMATCH,
  LOCK_CREDENTIAL_PREEXISTING,
  SCREEN_LOCK_UNSUPPORTED_ERROR,
  type ScreenLockCredentialType,
  type ScreenLockState,
  type SetScreenLockInput,
} from "./ScreenLockTypes";

/** Runs a screen-lock write with the id of the session that owns it (none when sessionless). */
export type ScreenLockMutation = (
  mutation: (owner: string | undefined) => Promise<ScreenLockState>,
) => Promise<ScreenLockState>;

export interface ScreenLockOperationsDependencies {
  device: () => BootedDevice;
  clientFactory: () => LockSettingsClientFactory;
  registry: () => ScreenLockRegistry;
  forgetRememberedUnlock: () => ForgetRememberedUnlock;
  mutation: () => ScreenLockMutation;
}

/** The screen-lock seams `DeviceState` accepts; each defaults to the production one. */
export interface ScreenLockDeviceStateDependencies {
  clientFactory?: LockSettingsClientFactory;
  registry?: ScreenLockRegistry;
  forgetRememberedUnlock?: ForgetRememberedUnlock;
  /** Session admission and ownership for a write; sessionless when absent. */
  mutation?: ScreenLockMutation;
}

/** Build the operations `DeviceState` drives, resolving the device and adb factory lazily. */
export function createScreenLockOperations(
  device: () => BootedDevice,
  adbFactory: () => AdbClientFactory,
  seams: ScreenLockDeviceStateDependencies = {},
): ScreenLockOperations {
  return new ScreenLockOperations({
    device,
    clientFactory: () => seams.clientFactory ?? defaultLockSettingsClientFactory(adbFactory()),
    registry: () => seams.registry ?? defaultScreenLockRegistry,
    forgetRememberedUnlock: () => seams.forgetRememberedUnlock ?? defaultForgetRememberedUnlock,
    mutation: () => seams.mutation ?? ((mutation) => mutation(undefined)),
  });
}

const SESSIONLESS_WARNING =
  "No session owns this credential, so nothing clears it automatically: clear it with " +
  'screenLock {type: "none", currentCredential} when done.';

function preexistingRefusal(reading: LockSettingsReading): ScreenLockState {
  const what = reading.type === "unknown" ? "a secure lock credential" : `a ${reading.type} lock`;
  return {
    supported: true,
    type: reading.type,
    secure: true,
    verified: false,
    errorCode: LOCK_CREDENTIAL_PREEXISTING,
    error:
      `${LOCK_CREDENTIAL_PREEXISTING}: the device already has ${what} that this session did not ` +
      'set; AutoMobile does not overwrite it. Clear it first with screenLock {type: "none", ' +
      "currentCredential}.",
  };
}

function commandFailure(
  outcome: string,
  detail: string | undefined,
  verb: string,
): ScreenLockState {
  return {
    supported: outcome !== "unsupported",
    verified: false,
    error: `locksettings ${verb} failed (${outcome}): ${detail ?? "no output"}`,
  };
}

/**
 * Set or clear a secure lock-screen credential with `locksettings` (#14107). A credential this
 * session sets is recorded in memory so the session can replace it (`--old`) and its release can
 * clear it; any other existing credential is refused with `lock_credential_preexisting`. Results
 * report the lock type and outcome only, never a credential.
 */
export class ScreenLockOperations {
  constructor(private readonly dependencies: ScreenLockOperationsDependencies) {}

  async read(): Promise<ScreenLockState> {
    const device = this.dependencies.device();
    if (device.platform !== "android") {
      return { supported: false, error: SCREEN_LOCK_UNSUPPORTED_ERROR };
    }
    const reading = await this.dependencies.clientFactory()(device).read();
    return {
      supported: true,
      type: reading.type,
      ...(reading.secure === undefined ? {} : { secure: reading.secure }),
      ...(reading.error ? { error: reading.error } : {}),
    };
  }

  write(input: SetScreenLockInput): Promise<ScreenLockState> {
    const device = this.dependencies.device();
    if (device.platform !== "android") {
      return Promise.resolve({
        supported: false,
        verified: false,
        error: SCREEN_LOCK_UNSUPPORTED_ERROR,
      });
    }
    return this.dependencies.mutation()(async (owner) => {
      const client = this.dependencies.clientFactory()(device);
      const before = await client.read();
      const lock = this.dependencies.registry().get(device.deviceId);
      const ownLock = owner !== undefined && lock?.sessionId === owner ? lock : undefined;
      return input.type === "none"
        ? this.clear(client, before, input.currentCredential)
        : this.set(
            client,
            before,
            { type: input.type, credential: input.credential },
            owner,
            ownLock,
          );
    });
  }

  private async set(
    client: LockSettingsClient,
    before: LockSettingsReading,
    requested: { type: ScreenLockCredentialType; credential: string },
    owner: string | undefined,
    ownLock: SessionScreenLock | undefined,
  ): Promise<ScreenLockState> {
    const deviceId = this.dependencies.device().deviceId;
    const unlocked = isUnlocked(before);
    if (!unlocked && !ownLock && (before.secure === true || before.type !== "unknown")) {
      return preexistingRefusal(before);
    }
    const old = unlocked ? undefined : ownLock?.credential;
    const result = await client.setCredential(requested.type, requested.credential, old);
    if (result.outcome === "credential_mismatch") {
      return this.refusedOldCredential(ownLock);
    }
    if (result.outcome !== "ok") {
      return commandFailure(result.outcome, result.detail, `set-${requested.type}`);
    }
    if (owner !== undefined) {
      this.dependencies.registry().record({ deviceId, sessionId: owner, ...requested });
    }
    await this.dependencies.forgetRememberedUnlock()(deviceId);
    return appliedSet(requested.type, unlocked, owner !== undefined, await client.read());
  }

  /** The device refused the old credential of a set: someone else's lock, or a stale own one. */
  private refusedOldCredential(ownLock: SessionScreenLock | undefined): ScreenLockState {
    if (!ownLock) {
      return preexistingRefusal({ type: "unknown", secure: true });
    }
    // The recorded credential is stale; release must not submit it and count a failed attempt.
    this.dependencies.registry().forget(ownLock.deviceId);
    return {
      supported: true,
      verified: false,
      errorCode: LOCK_CREDENTIAL_MISMATCH,
      error:
        `${LOCK_CREDENTIAL_MISMATCH}: the device refused the ${ownLock.type} this session set; ` +
        "it was changed outside AutoMobile, so the session no longer clears it on release.",
    };
  }

  private async clear(
    client: LockSettingsClient,
    before: LockSettingsReading,
    currentCredential: string,
  ): Promise<ScreenLockState> {
    const { deviceId } = this.dependencies.device();
    const registry = this.dependencies.registry();
    if (isUnlocked(before)) {
      registry.forget(deviceId);
      return { supported: true, type: "none", secure: false, outcome: "unchanged", verified: true };
    }
    const result = await client.clearCredential(currentCredential);
    if (result.outcome === "credential_mismatch") {
      return {
        supported: true,
        type: before.type,
        secure: true,
        verified: false,
        errorCode: LOCK_CREDENTIAL_MISMATCH,
        error:
          `${LOCK_CREDENTIAL_MISMATCH}: the device refused currentCredential; the refusal counts ` +
          "toward the device's failed-attempt lockout.",
      };
    }
    if (result.outcome !== "ok" && result.outcome !== "no_existing_credential") {
      return commandFailure(result.outcome, result.detail, "clear");
    }
    // Whoever set it, the credential is gone: nothing is left for a release to clear.
    registry.forget(deviceId);
    await this.dependencies.forgetRememberedUnlock()(deviceId);
    const after = await client.read();
    return {
      supported: true,
      type: "none",
      secure: false,
      cleared: result.outcome === "ok",
      outcome: result.outcome === "ok" ? "cleared" : "unchanged",
      ...verification(after, "none"),
      restoreOnRelease: false,
    };
  }
}

/** The result of a credential the device accepted, confirmed by the read taken after it. */
function appliedSet(
  type: ScreenLockCredentialType,
  wasUnlocked: boolean,
  owned: boolean,
  after: LockSettingsReading,
): ScreenLockState {
  const { warning, ...verified } = verification(after, type);
  const warnings = [warning, owned ? undefined : SESSIONLESS_WARNING].filter(
    (text): text is string => text !== undefined,
  );
  return {
    supported: true,
    type,
    secure: true,
    set: true,
    outcome: wasUnlocked ? "set" : "changed",
    ...verified,
    restoreOnRelease: owned,
    ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
  };
}

function isUnlocked(reading: LockSettingsReading): boolean {
  return reading.type === "none" || reading.secure === false;
}

/** Confirm a write with a fresh read; an unreadable type leaves `verified` unset. */
function verification(
  after: LockSettingsReading,
  expected: ScreenLockCredentialType | "none",
): Pick<ScreenLockState, "verified" | "error" | "warning"> {
  if (after.type === expected) {
    return { verified: true };
  }
  const expectedSecure = expected !== "none";
  if (after.secure === !expectedSecure) {
    return {
      verified: false,
      error: expectedSecure
        ? "locksettings reported success, but the device still reports no secure lock"
        : "locksettings reported the lock cleared, but the device still reports a secure lock",
    };
  }
  return {
    warning: `Could not confirm the lock type after the change (device reports ${after.type}).`,
  };
}
