import type {
  LockSettingsClient,
  LockSettingsCommandResult,
  LockSettingsReading,
} from "../../src/features/utility/screenLock/AndroidLockSettings";
import type { ScreenLockCredentialType } from "../../src/features/utility/screenLock/ScreenLockTypes";

export type FakeLockSettingsCall =
  | { method: "read" }
  | {
      method: "setCredential";
      type: ScreenLockCredentialType;
      credential: string;
      oldCredential?: string;
    }
  | { method: "clearCredential"; oldCredential: string };

/**
 * A device's lock as `locksettings` would hold it: `set`/`clear` succeed only with the right old
 * credential, like `LockSettingsShellCommand.checkCredential`, and reads report the stored type.
 * Queue `nextResults` to force an outcome (a transport failure, a refusal) for the next writes.
 */
export class FakeLockSettingsClient implements LockSettingsClient {
  calls: FakeLockSettingsCall[] = [];
  nextResults: LockSettingsCommandResult[] = [];
  /** Readings returned before the stored lock is consulted (an unreadable dump, …). */
  nextReadings: LockSettingsReading[] = [];

  constructor(public lock: { type: ScreenLockCredentialType; credential: string } | null = null) {}

  async read(): Promise<LockSettingsReading> {
    this.calls.push({ method: "read" });
    const forced = this.nextReadings.shift();
    if (forced) {
      return forced;
    }
    return this.lock ? { type: this.lock.type, secure: true } : { type: "none", secure: false };
  }

  async setCredential(
    type: ScreenLockCredentialType,
    credential: string,
    oldCredential?: string,
  ): Promise<LockSettingsCommandResult> {
    this.calls.push({
      method: "setCredential",
      type,
      credential,
      ...(oldCredential === undefined ? {} : { oldCredential }),
    });
    const forced = this.nextResults.shift();
    if (forced) {
      return forced;
    }
    const refused = this.checkOld(oldCredential);
    if (refused) {
      return refused;
    }
    this.lock = { type, credential };
    return { outcome: "ok" };
  }

  async clearCredential(oldCredential: string): Promise<LockSettingsCommandResult> {
    this.calls.push({ method: "clearCredential", oldCredential });
    const forced = this.nextResults.shift();
    if (forced) {
      return forced;
    }
    const refused = this.checkOld(oldCredential);
    if (refused) {
      return refused;
    }
    this.lock = null;
    return { outcome: "ok" };
  }

  writes(): FakeLockSettingsCall[] {
    return this.calls.filter((call) => call.method !== "read");
  }

  private checkOld(oldCredential: string | undefined): LockSettingsCommandResult | undefined {
    if (!this.lock) {
      return oldCredential
        ? { outcome: "no_existing_credential", detail: "user has no password" }
        : undefined;
    }
    return oldCredential === this.lock.credential
      ? undefined
      : { outcome: "credential_mismatch", detail: "Old password '<redacted>' didn't match" };
  }
}
