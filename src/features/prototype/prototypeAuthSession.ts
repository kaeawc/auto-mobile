import type { IdGenerator } from "../../utils/IdGenerator";
import { logger } from "../../utils/logger";
import { applyPrototypeDataWrite } from "./prototypeDataWrite";
import type { PrototypeData } from "./prototypeSpec";

/**
 * The fake identity provider's session (#14303). The executable reference the device runtimes
 * copy, like `applyPrototypeLocationOutcome` for `location.request`:
 *
 * - `auth.signIn` with a chosen account writes `{userId, name, email}` to `into` (default
 *   `/data/session`), mints an opaque `fake-<id>` token and saves `{token, userId, expiresAtMs}` in
 *   the secure store (Android Keystore / iOS Keychain). An unknown account, a full `/data` or a
 *   store failure is `platform_error` and changes nothing; `cancelled` and `unavailable` keep their
 *   code, and any other code becomes `platform_error`.
 * - `auth.signOut` clears the store and removes `into`.
 * - `auth.sessionExpired` (real TTL or simulated) clears the store and leaves `/data` to the
 *   spec's `platform.on` handlers.
 * - On launch, a stored session for a listed account that has not expired restores signed in;
 *   anything else is cleared, and a session past its TTL reports `expired`.
 *
 * The token lives only in the store: no result, `/data` value or `/platform` state carries it.
 */

export const PROTOTYPE_AUTH_ERROR_CODES = ["cancelled", "unavailable", "platform_error"] as const;
export type PrototypeAuthErrorCode = (typeof PROTOTYPE_AUTH_ERROR_CODES)[number];

/** `sessionTtlSeconds` when the root `auth` block leaves it out. */
export const PROTOTYPE_AUTH_DEFAULT_SESSION_TTL_SECONDS = 3600;
export const PROTOTYPE_AUTH_DEFAULT_INTO = "/data/session";

export interface PrototypeAuthAccount {
  id: string;
  name: string;
  email: string;
  avatar?: string;
}

export interface PrototypeAuthBlock {
  provider: "fake";
  accounts: PrototypeAuthAccount[];
  sessionTtlSeconds?: number;
}

export interface PrototypeAuthStoredSession {
  token: string;
  userId: string;
  expiresAtMs: number;
}

/** One prototype's slot in the Keystore-backed store or the Keychain. Writes may throw. */
export interface PrototypeAuthSessionStore {
  read(): PrototypeAuthStoredSession | undefined;
  write(session: PrototypeAuthStoredSession): void;
  clear(): void;
}

/** `/platform/auth`. */
export interface PrototypeAuthPlatformState {
  signedIn: boolean;
  userId?: string;
}

export interface PrototypeAuthError {
  code: PrototypeAuthErrorCode;
  message: string;
}

export type PrototypeAuthSignInOutcome =
  | { ok: true; userId: string }
  | { ok: false; error: { code: string; message: string } };

export interface PrototypeAuthContext {
  auth: PrototypeAuthBlock;
  store: PrototypeAuthSessionStore;
  nowMs: number;
}

export type PrototypeAuthCallResult =
  | { status: "success"; data: PrototypeData; platform: PrototypeAuthPlatformState }
  | {
      status: "error";
      data: PrototypeData;
      platform: PrototypeAuthPlatformState;
      error: PrototypeAuthError;
    };

const SIGNED_OUT: PrototypeAuthPlatformState = { signedIn: false };

const signedIn = (userId: string): PrototypeAuthPlatformState => ({ signedIn: true, userId });

function typedCode(code: string): PrototypeAuthErrorCode {
  return (PROTOTYPE_AUTH_ERROR_CODES as readonly string[]).includes(code)
    ? (code as PrototypeAuthErrorCode)
    : "platform_error";
}

/** The `/platform/auth` state the store holds now, without changing it. */
export function prototypeAuthPlatformState(
  context: PrototypeAuthContext,
): PrototypeAuthPlatformState {
  const stored = context.store.read();
  return stored && validSession(stored, context) ? signedIn(stored.userId) : SIGNED_OUT;
}

function validSession(stored: PrototypeAuthStoredSession, context: PrototypeAuthContext): boolean {
  return (
    stored.expiresAtMs > context.nowMs &&
    context.auth.accounts.some((account) => account.id === stored.userId)
  );
}

/**
 * Applies one `auth.signIn` result. `data` is unchanged on any error, and the store keeps the
 * previous session, so a failed sign-in never signs the user out.
 */
export function applyPrototypeAuthSignIn(
  data: PrototypeData,
  into: string | undefined,
  outcome: PrototypeAuthSignInOutcome,
  context: PrototypeAuthContext & { ids: IdGenerator },
): PrototypeAuthCallResult {
  const failed = (code: string, message: string): PrototypeAuthCallResult => ({
    status: "error",
    data,
    platform: prototypeAuthPlatformState(context),
    error: { code: typedCode(code), message },
  });
  if (!outcome.ok) {
    return failed(outcome.error.code, outcome.error.message);
  }
  const account = context.auth.accounts.find((candidate) => candidate.id === outcome.userId);
  if (!account) {
    return failed("platform_error", `no account ${outcome.userId}`);
  }
  const written = applyPrototypeDataWrite(data, {
    op: "set",
    path: into ?? PROTOTYPE_AUTH_DEFAULT_INTO,
    value: { userId: account.id, name: account.name, email: account.email },
  });
  if (!written.success) {
    return failed("platform_error", `into ${written.error.message}`);
  }
  const ttlSeconds = context.auth.sessionTtlSeconds ?? PROTOTYPE_AUTH_DEFAULT_SESSION_TTL_SECONDS;
  try {
    context.store.write({
      token: `fake-${context.ids.next()}`,
      userId: account.id,
      expiresAtMs: context.nowMs + ttlSeconds * 1000,
    });
  } catch (error) {
    // The store's own message may echo the token it was given: log and report only the name.
    const name = error instanceof Error ? error.name : "unknown";
    logger.warn(`[prototype] auth session store write failed: ${name}`);
    return failed("platform_error", `session store write failed (${name})`);
  }
  return { status: "success", data: written.data, platform: signedIn(account.id) };
}

/** `auth.signOut`: clears the session and removes `into` when it holds a value. */
export function applyPrototypeAuthSignOut(
  data: PrototypeData,
  into: string | undefined,
  context: Pick<PrototypeAuthContext, "store">,
): PrototypeAuthCallResult {
  context.store.clear();
  const removed = applyPrototypeDataWrite(data, {
    op: "remove",
    path: into ?? PROTOTYPE_AUTH_DEFAULT_INTO,
  });
  return { status: "success", data: removed.success ? removed.data : data, platform: SIGNED_OUT };
}

/** `auth.sessionExpired`: clears the session; the spec's handlers decide what `/data` shows. */
export function applyPrototypeAuthSessionExpired(
  context: Pick<PrototypeAuthContext, "store">,
): PrototypeAuthPlatformState {
  context.store.clear();
  return SIGNED_OUT;
}

/**
 * The state at launch. A session that outlived its TTL is cleared and reported as `expired`, so
 * the runtime raises `auth.sessionExpired`; one for an account the spec no longer lists is cleared
 * silently.
 */
export function restorePrototypeAuthSession(context: PrototypeAuthContext): {
  platform: PrototypeAuthPlatformState;
  expired: boolean;
} {
  const stored = context.store.read();
  if (!stored) {
    return { platform: SIGNED_OUT, expired: false };
  }
  if (validSession(stored, context)) {
    return { platform: signedIn(stored.userId), expired: false };
  }
  context.store.clear();
  return { platform: SIGNED_OUT, expired: stored.expiresAtMs <= context.nowMs };
}
