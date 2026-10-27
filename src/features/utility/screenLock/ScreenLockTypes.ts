import { z } from "zod/v4";

/** A secure credential `locksettings` can set (#14107). */
export type ScreenLockCredentialType = "pin" | "password" | "pattern";

/** What `setDeviceState.screenLock.type` accepts: a credential type, or `none` to clear. */
export type ScreenLockType = ScreenLockCredentialType | "none";

/** The credential type a device reports; `unknown` when it could not be read. */
export type ObservedScreenLockType = ScreenLockType | "unknown";

/** Typed refusal: the device already has a credential this session did not set. */
export const LOCK_CREDENTIAL_PREEXISTING = "lock_credential_preexisting";
/** Typed failure: the device rejected the old credential AutoMobile supplied. */
export const LOCK_CREDENTIAL_MISMATCH = "lock_credential_mismatch";

export type ScreenLockErrorCode =
  | typeof LOCK_CREDENTIAL_PREEXISTING
  | typeof LOCK_CREDENTIAL_MISMATCH;

export const SCREEN_LOCK_UNSUPPORTED_ERROR =
  "screenLock is Android-only: iOS has no command to set a device passcode.";

// Every message below describes the rule, never the value: the credential must not reach a
// validation error, a tool response or a log.
const PIN_RULE = "screenLock.credential for a pin must be 4-16 digits";
const PASSWORD_RULE =
  "screenLock.credential for a password must be 4-16 printable ASCII characters, must not start " +
  "with '-' and must not contain a single quote";
const PATTERN_RULE =
  "screenLock.credential for a pattern must be 4-9 distinct digits 1-9 (the 3x3 grid, row by row)";
const CURRENT_CREDENTIAL_RULE =
  "screenLock.currentCredential must be 4-16 printable ASCII characters, must not start with '-' " +
  "and must not contain a single quote";

/**
 * A single quote is refused because AutoMobile quotes the credential for the device shell and
 * scrubs every quoted form of it from command errors; `-` would read as a `locksettings` option.
 */
const PASSWORD_PATTERN = /^(?!-)[\x20-\x26\x28-\x7e]{4,16}$/;

function isDistinctGridPattern(value: string): boolean {
  return /^[1-9]{4,9}$/.test(value) && new Set(value).size === value.length;
}

export const screenLockInputSchema = z.union([
  z
    .object({
      type: z.literal("pin"),
      credential: z.string().regex(/^\d{4,16}$/, PIN_RULE),
    })
    .strict(),
  z
    .object({
      type: z.literal("password"),
      credential: z.string().regex(PASSWORD_PATTERN, PASSWORD_RULE),
    })
    .strict(),
  z
    .object({
      type: z.literal("pattern"),
      credential: z
        .string()
        .regex(/^[1-9]{4,9}$/, PATTERN_RULE)
        .refine(isDistinctGridPattern, PATTERN_RULE),
    })
    .strict(),
  z
    .object({
      type: z.literal("none"),
      currentCredential: z.string().regex(PASSWORD_PATTERN, CURRENT_CREDENTIAL_RULE),
    })
    .strict(),
]);

export type SetScreenLockInput = z.infer<typeof screenLockInputSchema>;

/**
 * `screenLock` as getDeviceState and setDeviceState report it. Never carries a credential: a
 * set reports only the type and whether it was applied (`set: true`).
 */
export interface ScreenLockState {
  supported: boolean;
  /** The credential type now on the device (after a write, the requested one). */
  type?: ObservedScreenLockType;
  /** Whether a secure credential is set, when known. */
  secure?: boolean;
  /** A credential was applied by this call. */
  set?: boolean;
  /** The device credential was removed by this call. */
  cleared?: boolean;
  outcome?: "set" | "changed" | "cleared" | "unchanged";
  /** A fresh read confirmed the resulting credential type. */
  verified?: boolean;
  /** Session release will clear this credential (false for a sessionless set). */
  restoreOnRelease?: boolean;
  errorCode?: ScreenLockErrorCode;
  warning?: string;
  error?: string;
}

/** Outcome of clearing a session's credential at release, surfaced in the release result. */
export interface ScreenLockRestoreReport {
  status: "cleared" | "failed" | "skipped";
  deviceId: string;
  type: ScreenLockCredentialType;
  verified?: boolean;
  /** Why the clear failed or was skipped; never contains the credential. */
  error?: string;
  /** For a failure: what is left on the device and how to remove it. */
  leftover?: string;
}

/** The `setDeviceState.screenLock` field description (kept here to spare utilityTools.ts). */
export const SCREEN_LOCK_INPUT_DESCRIPTION =
  "Android only. Set a secure lock-screen credential (type pin, password, or pattern as digits " +
  "1-9) with locksettings, or clear one with type none and currentCredential. A session clears " +
  "the credential it set on release and reports a failed clear in the release result " +
  "(screenLockRestore); a sessionless set is never cleared automatically. An existing credential " +
  "this session did not set is never overwritten (errorCode lock_credential_preexisting). The " +
  "credential is redacted from logs, telemetry and recorded plans, and never returned.";
