import { AdbCommandTimeoutError } from "../../utils/android-cmdline-tools/AdbClient";
import { defaultRetryExecutor, type RetryExecutor } from "../../utils/retry/RetryExecutor";
import { DUMPSYS_MAX_BUFFER } from "../../utils/android-cmdline-tools/dumpsysLimits";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { AndroidCtrlProxyManager } from "../../ctrlProxy/CtrlProxyManager";
import { AndroidUserTargetResolver } from "../../utils/android-cmdline-tools/AndroidUserTargetResolver";
import { logger } from "../../utils/logger";
import { clearAndroidImeQuarantine, withAndroidImeLock } from "./androidImeLock";

const SUBTYPE_KEY = "selected_input_method_subtype";

/** `ime set` normally completes well under 1s; bound the post-dispatch
 * window while the per-device IME lock is held. */
const IME_SET_COMMAND_TIMEOUT_MS = 5_000;
const IME_READ_COMMAND_TIMEOUT_MS = 3_000;

export interface InstalledIme {
  id: string;
  enabled: boolean;
  active: boolean;
  capabilities: ImeCapabilities;
}

export interface ImeCapabilities {
  visibleKeyTap: boolean;
  gesture: boolean;
  suggestion: boolean;
  clipboard: boolean;
  semanticText: boolean;
}

export interface KeyboardIdentity {
  component: string;
  package: string;
  versionName?: string;
  subtype?: string;
}

export interface ImeSubtypeSnapshot {
  id: number | null;
  locale?: string;
}

export const AUTO_MOBILE_IME_ID = `${AndroidCtrlProxyManager.PACKAGE}/.ime.CtrlProxyIme`;

export function imeCapabilities(id: string): ImeCapabilities {
  return {
    visibleKeyTap: id !== AUTO_MOBILE_IME_ID,
    gesture: false,
    suggestion: false,
    clipboard: false,
    semanticText: id === AUTO_MOBILE_IME_ID,
  };
}

export function parseSelectedImeSubtype(output: string | undefined): number | null {
  const value = output?.trim();
  if (!value || value === "null") {
    return null;
  }
  if (!/^-?\d+$/.test(value)) {
    throw new Error(`Invalid selected IME subtype: ${value}`);
  }
  const id = Number(value);
  if (!Number.isSafeInteger(id)) {
    throw new Error(`Invalid selected IME subtype: ${value}`);
  }
  return id === -1 ? null : id;
}

/** Restrict package metadata to the Packages block, avoiding versionName in unrelated dumps. */
export function parsePackageVersionName(output: string, packageName: string): string | undefined {
  const packages = output.split(/^Packages:\s*$/m)[1]?.split(/^\S[^\n]*:\s*$/m)[0];
  const packageBlock = packages?.split(/^\s{2}Package \[([^\]]+)\][^\n]*:\s*$/m).slice(1);
  if (!packageBlock) {
    return undefined;
  }
  for (let index = 0; index < packageBlock.length; index += 2) {
    if (packageBlock[index] === packageName) {
      return packageBlock[index + 1]?.match(/^\s+versionName=(\S+)\s*$/m)?.[1];
    }
  }
  return undefined;
}

/** Parse subtype rows scoped to the selected IME's mId block in dumpsys input_method. */
export function parseAdvertisedImeSubtypes(
  output: string,
  imeId: string,
): Map<number, string | undefined> | undefined {
  const block = output
    .split(/^\s*mId=/m)
    .slice(1)
    .find(
      (part) =>
        part.startsWith(imeId) && (part.length === imeId.length || /\s/.test(part[imeId.length])),
    );
  if (!block) {
    return undefined;
  }
  const subtypes = new Map<number, string | undefined>();
  for (const line of block.split(/\r?\n/)) {
    const id = line.match(/\b(?:mSubtypeId|subtypeId)=(-?\d+)\b/);
    if (id) {
      const numericId = Number(id[1]);
      if (Number.isSafeInteger(numericId)) {
        subtypes.set(numericId, line.match(/\b(?:mSubtypeLocale|locale)=([^\s,}]+)/)?.[1]);
      }
    }
  }
  return subtypes;
}

/** Supplies the Android user whose keyboard a catalog operation reads and changes. */
export interface ForegroundUserSource {
  foregroundUserId(signal?: AbortSignal): Promise<number>;
}

/** Resolves the current (foreground) user with the shared Android user resolver. */
export function createForegroundUserSource(adb: AdbExecutor): ForegroundUserSource {
  const resolver = new AndroidUserTargetResolver(adb);
  return {
    foregroundUserId: async (signal) =>
      (await resolver.resolve({ currentUser: true, signal })).userId,
  };
}

/** A source fixed to one user, so a multi-step operation and its restore cannot diverge. */
export function pinnedUser(userId: number): ForegroundUserSource {
  return { foregroundUserId: async () => userId };
}

/**
 * `ime` acts on the current user and `settings` on user 0 when `--user` is omitted. Every
 * command passes the same explicit user so they cannot disagree. User 0 omits the flag: both
 * defaults already mean user 0 there, so single-user devices keep their exact commands and
 * never depend on `ime --user`, which older Android releases do not accept.
 */
export function imeUserArgs(userId: number): string[] {
  return userId === 0 ? [] : ["--user", String(userId)];
}

export interface ImeCatalogState {
  activeImeId: string | null;
  installed: InstalledIme[];
}

/** System IMEs are Android components, distinct from CtrlProxy typing profiles. */
export class AndroidImeCatalog {
  constructor(
    private readonly adb: Pick<AdbExecutor, "execute">,
    private readonly deviceId: string,
    private readonly users: ForegroundUserSource,
    private readonly retry: RetryExecutor = defaultRetryExecutor,
  ) {}

  /**
   * A catalog fixed to the user that is foreground right now. A scoped session that switches
   * the keyboard and later restores it uses this so both reach the same user even if the
   * foreground user changes in between.
   */
  async pinForeground(signal?: AbortSignal): Promise<AndroidImeCatalog> {
    const userId = await this.users.foregroundUserId(signal);
    return new AndroidImeCatalog(this.adb, this.deviceId, pinnedUser(userId), this.retry);
  }

  async list(signal?: AbortSignal): Promise<ImeCatalogState> {
    return this.listForUser(await this.users.foregroundUserId(signal), signal);
  }

  private async listForUser(userId: number, signal?: AbortSignal): Promise<ImeCatalogState> {
    const user = imeUserArgs(userId);
    const [installed, enabled, active] = await Promise.all([
      this.readImeIds(["shell", "ime", "list", ...user, "-a", "-s"], signal),
      this.readImeIds(["shell", "ime", "list", ...user, "-s"], signal),
      this.readActiveIme(userId, signal),
    ]);
    const enabledIds = new Set(enabled);
    return {
      activeImeId: active,
      installed: installed.map((id) => ({
        id,
        enabled: enabledIds.has(id),
        active: id === active,
        capabilities: imeCapabilities(id),
      })),
    };
  }

  async readSubtype(imeId: string, signal?: AbortSignal): Promise<ImeSubtypeSnapshot> {
    const userId = await this.users.foregroundUserId(signal);
    const selected = await this.readCommand(
      ["shell", "settings", ...imeUserArgs(userId), "get", "secure", SUBTYPE_KEY],
      signal,
    );
    if (selected.stderr.trim()) {
      throw new Error(`Failed to read IME subtype: ${selected.stderr.trim()}`);
    }
    const id = parseSelectedImeSubtype(selected.stdout);
    if (id === null) {
      return { id: null };
    }
    const subtypes = await this.advertisedSubtypes(imeId, signal);
    return { id, ...(subtypes?.get(id) ? { locale: subtypes.get(id) } : {}) };
  }

  /** Caller holds the per-device lock; an unavailable subtype table is verified by readback. */
  async restoreSubtypeWithinLock(imeId: string, snapshot: ImeSubtypeSnapshot): Promise<void> {
    const user = imeUserArgs(await this.users.foregroundUserId());
    if (snapshot.id !== null) {
      const advertised = await this.advertisedSubtypes(imeId);
      if (advertised && !advertised.has(snapshot.id)) {
        throw new Error(`Original IME subtype ${snapshot.id} is no longer advertised by ${imeId}.`);
      }
    }
    const args =
      snapshot.id === null
        ? ["shell", "settings", ...user, "delete", "secure", SUBTYPE_KEY]
        : ["shell", "settings", ...user, "put", "secure", SUBTYPE_KEY, String(snapshot.id)];
    const result = await this.adb.execute(args, { noRetry: true });
    if (result.stderr.trim()) {
      throw new Error(`Failed to restore IME subtype: ${result.stderr.trim()}`);
    }
    const after = await this.readCommand([
      "shell",
      "settings",
      ...user,
      "get",
      "secure",
      SUBTYPE_KEY,
    ]);
    if (after.stderr.trim() || parseSelectedImeSubtype(after.stdout) !== snapshot.id) {
      throw new Error(`IME subtype restoration could not be verified for ${imeId}.`);
    }
  }

  async identity(imeId: string, subtype?: ImeSubtypeSnapshot): Promise<KeyboardIdentity> {
    const packageName = imeId.split("/")[0];
    const identity: KeyboardIdentity = { component: imeId, package: packageName };
    try {
      const result = await this.adb.execute(["shell", "dumpsys", "package", packageName], {
        maxBuffer: DUMPSYS_MAX_BUFFER,
      });
      if (!result.stderr.trim()) {
        const versionName = parsePackageVersionName(result.stdout, packageName);
        if (versionName) {
          identity.versionName = versionName;
        }
      }
    } catch (error) {
      // Package metadata is optional; failure does not affect the selected keyboard or tap.
      logger.debug(`[AndroidImeCatalog] Optional package metadata unavailable: ${String(error)}`);
    }
    if (subtype?.locale) {
      identity.subtype = subtype.locale;
    }
    return identity;
  }

  private async advertisedSubtypes(imeId: string, signal?: AbortSignal) {
    const result = await this.adb.execute(["shell", "dumpsys", "input_method"], {
      signal,
      maxBuffer: DUMPSYS_MAX_BUFFER,
    });
    if (result.stderr.trim()) {
      throw new Error(`Failed to inspect IME subtypes: ${result.stderr.trim()}`);
    }
    return parseAdvertisedImeSubtypes(result.stdout, imeId);
  }

  async select(id: string, signal?: AbortSignal): Promise<ImeCatalogState> {
    return withAndroidImeLock(
      this.deviceId,
      async () => {
        const state = await this.selectWithinLock(id, signal);
        // Explicit recovery clears quarantine only after active-IME readback, under the lock.
        clearAndroidImeQuarantine(this.deviceId);
        return state;
      },
      signal,
      { allowQuarantined: true },
    );
  }

  /** For a scoped session that already holds the device IME lock. */
  async selectWithinLock(id: string, signal?: AbortSignal): Promise<ImeCatalogState> {
    // One user for the read, the `ime set` and the readback, so the check verifies the change.
    const userId = await this.users.foregroundUserId(signal);
    const before = await this.listForUser(userId, signal);
    const target = before.installed.find((ime) => ime.id === id);
    if (!target) {
      throw new Error(`IME ${id} is not installed on this Android device.`);
    }
    if (!target.enabled) {
      throw new Error(`IME ${id} is installed but disabled; enable it on the device first.`);
    }
    if (before.activeImeId === id) {
      return before;
    }
    // Forward cancellation until dispatch. Once ADB starts, the device may have
    // applied the change; finish the command and verify the actual IME state.
    const commandController = signal ? new AbortController() : undefined;
    const forwardAbort = () => commandController?.abort(signal?.reason);
    signal?.throwIfAborted();
    signal?.addEventListener("abort", forwardAbort, { once: true });
    let result;
    try {
      result = await this.adb.execute(["shell", "ime", "set", ...imeUserArgs(userId), id], {
        signal: commandController?.signal,
        timeoutMs: IME_SET_COMMAND_TIMEOUT_MS,
        noRetry: true,
        waitForProcessSettlementAfterAbort: true,
        beforeDispatch: async () => {
          signal?.throwIfAborted();
          signal?.removeEventListener("abort", forwardAbort);
        },
      });
    } finally {
      signal?.removeEventListener("abort", forwardAbort);
    }
    if (result.stderr.trim()) {
      throw new Error(`Failed to select IME ${id}: ${result.stderr.trim()}`);
    }
    // The IME may already have changed. Verify it under the lock even if cancellation
    // arrives after dispatch, as the native key tap path does after a physical tap.
    const after = await this.listForUser(userId);
    if (after.activeImeId !== id) {
      throw new Error(
        `IME selection did not take effect: expected ${id}, got ${after.activeImeId ?? "none"}.`,
      );
    }
    return after;
  }

  /** Only idempotent IME/settings reads belong here; mutations are dispatched once. */
  private readCommand(args: string[], signal?: AbortSignal) {
    return this.retry.executeOrThrow(
      () =>
        this.adb.execute(args, { signal, timeoutMs: IME_READ_COMMAND_TIMEOUT_MS, noRetry: true }),
      {
        maxAttempts: 2,
        delays: 0,
        signal,
        shouldRetry: (error) => error instanceof AdbCommandTimeoutError,
      },
    );
  }

  private async readImeIds(args: string[], signal?: AbortSignal): Promise<string[]> {
    const result = await this.readCommand(args, signal);
    if (result.stderr.trim()) {
      throw new Error(`Failed to list Android IMEs: ${result.stderr.trim()}`);
    }
    // `ime list -s` emits one component id per line, according to Android's IME shell command.
    // Ignore whitespace-only rows; reject diagnostics so they cannot become selectable ids.
    const ids = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (ids.some((id) => !/^[A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+$/.test(id))) {
      throw new Error("Android returned an invalid IME component list.");
    }
    return [...new Set(ids)];
  }

  private async readActiveIme(userId: number, signal?: AbortSignal): Promise<string | null> {
    const result = await this.readCommand(
      ["shell", "settings", ...imeUserArgs(userId), "get", "secure", "default_input_method"],
      signal,
    );
    if (result.stderr.trim()) {
      throw new Error(`Failed to read active IME: ${result.stderr.trim()}`);
    }
    const id = result.stdout.trim();
    return id && id !== "null" ? id : null;
  }
}
