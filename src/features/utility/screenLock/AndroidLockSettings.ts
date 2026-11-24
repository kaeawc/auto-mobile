import type { BootedDevice } from "../../../models";
import { toActionableError } from "../../../models/ActionableError";
import type { AdbExecutor } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../../../utils/android-cmdline-tools/AdbClientFactory";
import { AndroidUserTargetResolver } from "../../../utils/android-cmdline-tools/AndroidUserTargetResolver";
import { DUMPSYS_MAX_BUFFER } from "../../../utils/android-cmdline-tools/dumpsysLimits";
import { errorMessage } from "../../../utils/describeUnknownError";
import { withFixtureCaptureScrub } from "../../../utils/fixtureCapture/fixtureCaptureScope";
import { logger } from "../../../utils/logger";
import { TOOL_SECRET_PLACEHOLDER } from "../../../utils/redactToolSecrets";
import { shellQuoteUnlessSafe } from "../../../utils/shellQuote";
import type { ObservedScreenLockType, ScreenLockCredentialType } from "./ScreenLockTypes";

/** `locksettings` re-encrypts the synthetic password; give it more than a plain shell read. */
export const LOCK_SETTINGS_COMMAND_TIMEOUT_MS = 15_000;
const LOCK_SETTINGS_READ_TIMEOUT_MS = 10_000;

/** Shown in adb logs, perf spans and error messages instead of a command carrying a credential. */
export const LOCK_SETTINGS_LOG_LABEL = "shell locksettings <credential redacted>";

/**
 * The device shell always exits 0 and prints the `locksettings` status after this marker, so a
 * refused command resolves instead of rejecting: AdbClient then never formats the command's
 * output (which echoes the old credential, `Old password '…' didn't match`) into an error or a
 * failure log. Only this module reads that output, and it scrubs it first.
 */
const EXIT_MARKER = "AUTOMOBILE_LOCKSETTINGS_EXIT=";

export interface LockSettingsReading {
  type: ObservedScreenLockType;
  /** Whether a secure credential is set, when known (also when the type is not). */
  secure?: boolean;
  error?: string;
}

export type LockSettingsOutcome =
  | "ok"
  | "credential_mismatch"
  | "no_existing_credential"
  | "unsupported"
  | "rejected"
  | "failed";

export interface LockSettingsCommandResult {
  outcome: LockSettingsOutcome;
  /** Device or transport text explaining a failure, with every credential scrubbed. */
  detail?: string;
}

/** The `locksettings` surface the screen-lock feature drives (one device, one Android user). */
export interface LockSettingsClient {
  read(): Promise<LockSettingsReading>;
  setCredential(
    type: ScreenLockCredentialType,
    credential: string,
    oldCredential?: string,
  ): Promise<LockSettingsCommandResult>;
  clearCredential(oldCredential: string): Promise<LockSettingsCommandResult>;
  /** The Android user this client targets: resolved once, so a set can record it for release. */
  targetUserId(): Promise<number>;
}

/** `userId` pins the client to the user a lock was set on instead of resolving the foreground. */
export interface LockSettingsClientOptions {
  userId?: number;
}

export type LockSettingsClientFactory = (
  device: BootedDevice,
  options?: LockSettingsClientOptions,
) => LockSettingsClient;

/**
 * Replace every secret, and its device-shell-quoted form, in `text`. Longest first, so a secret
 * that contains a shorter one is never left partly visible.
 */
export function scrubLockCredentials(text: string, secrets: readonly string[]): string {
  return secrets
    .filter((secret) => secret.length > 0)
    .flatMap((secret) => [shellQuoteUnlessSafe(secret), secret])
    .toSorted((a, b) => b.length - a.length)
    .reduce((scrubbed, secret) => scrubbed.split(secret).join(TOOL_SECRET_PLACEHOLDER), text);
}

const CREDENTIAL_TYPE_NAMES: Readonly<Record<string, ObservedScreenLockType>> = {
  none: "none",
  pin: "pin",
  password: "password",
  pattern: "pattern",
  // Integer forms from releases that print the raw constant (Android 10 and earlier).
  "-1": "none",
  "1": "pattern",
  "3": "pin",
  "4": "password",
};

/**
 * The `CredentialType:` of one user (default 0) from `dumpsys lock_settings` (#14107). Android 11+ prints a name
 * (`None`, `Pin`, `Password`, `Pattern`); older releases print the constant, where `2` is a PIN
 * or a password and so only says the lock is secure. Anything else is `unknown`.
 */
export function parseLockSettingsCredentialType(dump: string, userId = 0): LockSettingsReading {
  const lines = dump.split(/\r?\n/);
  const userStart = lines.findIndex((line) => new RegExp(`^\\s*User ${userId}\\s*$`).test(line));
  const nextUser = lines.findIndex(
    (line, index) => index > userStart && /^\s*User \d+\s*$/.test(line),
  );
  const scope =
    userStart < 0 ? lines : lines.slice(userStart + 1, nextUser < 0 ? undefined : nextUser);
  const raw = scope
    .map((line) => /^\s*CredentialType:\s*(\S+)/.exec(line)?.[1])
    .find((value) => value !== undefined);
  if (raw === undefined) {
    return { type: "unknown" };
  }
  if (raw === "2") {
    return { type: "unknown", secure: true };
  }
  const type = CREDENTIAL_TYPE_NAMES[raw.toLowerCase()] ?? "unknown";
  return type === "unknown" ? { type } : { type, secure: type !== "none" };
}

/** Classify scrubbed `locksettings` output by its AOSP `LockSettingsShellCommand` messages. */
export function classifyLockSettingsOutput(
  output: string,
  exitCode: number | undefined,
): LockSettingsOutcome {
  if (/didn't match|did not match/i.test(output)) {
    return "credential_mismatch";
  }
  if (/user has no password|no password set/i.test(output)) {
    return "no_existing_credential";
  }
  if (/does not support lock screen|not found|unknown command|can't find service/i.test(output)) {
    return "unsupported";
  }
  if (/doesn't satisfy|not sufficient|throttled|invalid|too short|too long/i.test(output)) {
    return "rejected";
  }
  return exitCode === 0 ? "ok" : "failed";
}

type LockSettingsAdb = Pick<AdbExecutor, "execute" | "getDeviceLock">;

/** Resolves the Android user `locksettings` is aimed at and the reader inspects. */
export type LockUserResolver = () => Promise<number>;

const SYSTEM_USER: LockUserResolver = async () => 0;

/**
 * User 0 everywhere except Android Automotive, where the system user is headless and the driver
 * (often user 10) is the foreground user: a lock set on user 0 never reaches the driver (#19060).
 * Throws an `ActionableError` when the foreground user cannot be read: falling back to user 0
 * would put the lock on the headless system user and read it back from there, reporting a
 * success the driver never sees (#19070).
 */
export function createLockUserResolver(
  adb: AdbExecutor,
  device: Pick<BootedDevice, "formFactor">,
): LockUserResolver {
  if (device.formFactor !== "automotive") {
    return SYSTEM_USER;
  }
  return async () => {
    try {
      return (await new AndroidUserTargetResolver(adb).resolve({ currentUser: true })).userId;
    } catch (error) {
      throw toActionableError(
        error,
        "Could not read the Android Automotive foreground user for the screen lock",
      );
    }
  };
}

/**
 * {@link LockSettingsClient} over adb: `locksettings` writes, `dumpsys lock_settings` reads.
 * One client serves one operation: the user is resolved once, on first use, and every set,
 * clear and read-back of that client targets it, so they cannot disagree (#19014, #19070).
 */
export class AdbLockSettingsClient implements LockSettingsClient {
  private resolvedUser: Promise<number> | undefined;

  constructor(
    private readonly adb: LockSettingsAdb,
    private readonly resolveUserOnce: LockUserResolver = SYSTEM_USER,
  ) {}

  private resolveUser(): Promise<number> {
    this.resolvedUser ??= this.resolveUserOnce();
    return this.resolvedUser;
  }

  targetUserId(): Promise<number> {
    return this.resolveUser();
  }

  async read(): Promise<LockSettingsReading> {
    const userId = await this.resolveUser();
    try {
      const result = await this.adb.execute(["shell", "dumpsys", "lock_settings"], {
        noRetry: true,
        timeoutMs: LOCK_SETTINGS_READ_TIMEOUT_MS,
        maxBuffer: DUMPSYS_MAX_BUFFER,
      });
      const reading = parseLockSettingsCredentialType(result.stdout, userId);
      return reading.type === "unknown" && reading.secure === undefined
        ? await this.readKeyguardSecure()
        : reading;
    } catch (error) {
      logger.warn(`[screenLock] dumpsys lock_settings failed: ${errorMessage(error)}`, error);
      return {
        type: "unknown",
        error: `Could not read the lock credential type: ${errorMessage(error)}`,
      };
    }
  }

  async setCredential(
    type: ScreenLockCredentialType,
    credential: string,
    oldCredential?: string,
  ): Promise<LockSettingsCommandResult> {
    const old = oldCredential === undefined ? [] : ["--old", oldCredential];
    return this.run(
      [`set-${type}`, "--user", String(await this.resolveUser()), ...old, credential],
      [credential, oldCredential ?? ""],
    );
  }

  async clearCredential(oldCredential: string): Promise<LockSettingsCommandResult> {
    const user = String(await this.resolveUser());
    return this.run(["clear", "--user", user, "--old", oldCredential], [oldCredential]);
  }

  /** `secure` from `dumpsys window policy` when this release's lock_settings dump has no type. */
  private async readKeyguardSecure(): Promise<LockSettingsReading> {
    const lock = await this.adb.getDeviceLock();
    if (lock?.secure === false) {
      return { type: "none", secure: false };
    }
    return lock?.secure === true ? { type: "unknown", secure: true } : { type: "unknown" };
  }

  private async run(args: string[], secrets: string[]): Promise<LockSettingsCommandResult> {
    const argv = ["shell", "locksettings", ...args.map(shellQuoteUnlessSafe), ";"];
    try {
      // A refused change echoes the old credential; fixture capture applies the same scrub as
      // the logs, so a capture never holds the device PIN.
      const result = await withFixtureCaptureScrub(
        (text) => scrubLockCredentials(text, secrets),
        () =>
          this.adb.execute([...argv, "echo", `${EXIT_MARKER}$?`], {
            // A retried set would be refused for the credential its first attempt already set.
            noRetry: true,
            timeoutMs: LOCK_SETTINGS_COMMAND_TIMEOUT_MS,
            logLabel: LOCK_SETTINGS_LOG_LABEL,
          }),
      );
      const exitLine = new RegExp(`${EXIT_MARKER}(\\d+)`).exec(result.stdout);
      const raw =
        `${result.stdout.replace(exitLine?.[0] ?? EXIT_MARKER, "")}\n${result.stderr}`.trim();
      // Classify the raw text (a credential could collide with a status word); keep only the
      // scrubbed text.
      const outcome = classifyLockSettingsOutput(raw, exitLine ? Number(exitLine[1]) : undefined);
      return outcome === "ok"
        ? { outcome }
        : { outcome, detail: scrubLockCredentials(raw, secrets) || "no output" };
    } catch (error) {
      // Only the scrubbed text is logged: the raw error (and its `cause`) keeps the device output.
      const detail = scrubLockCredentials(errorMessage(error), secrets);
      logger.warn(`[screenLock] locksettings ${args[0]} failed: ${detail}`);
      return { outcome: "failed", detail };
    }
  }
}

export const defaultLockSettingsClientFactory = (
  adbFactory: AdbClientFactory = defaultAdbClientFactory,
): LockSettingsClientFactory => {
  return (device, options) => {
    const adb = adbFactory.create(device);
    const { userId } = options ?? {};
    return new AdbLockSettingsClient(
      adb,
      userId === undefined ? createLockUserResolver(adb, device) : async () => userId,
    );
  };
};
