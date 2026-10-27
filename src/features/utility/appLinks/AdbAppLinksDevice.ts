import { ActionableError } from "../../../models/ActionableError";
import { AndroidUserTargetResolver } from "../../../utils/android-cmdline-tools/AndroidUserTargetResolver";
import type { AdbExecutor } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { readAndroidDeviceApiLevel } from "../../../utils/android-cmdline-tools/readAndroidDeviceApiLevel";
import { outputLooksLikeShellFailure } from "../../../utils/android-cmdline-tools/shellOutputHeuristics";
import { shellQuote } from "../../../utils/shellQuote";
import {
  APP_LINK_SETTABLE_STATE_CODES,
  appLinksOutputReportsUnsupported,
  parseAppLinksOutput,
  type AppLinkSettableState,
  type AppLinksRead,
} from "./appLinksOutput";

export interface AppLinksCommandOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** `"all"` targets every domain the package declares. */
export type AppLinkDomainSelector = readonly string[] | "all";

/** The device's domain verification shell (#14110); one instance targets one device. */
export interface AppLinksDevice {
  /** `pm get-app-links [--user <id>] <pkg>`; without a user only verification states are read. */
  read(
    packageName: string,
    userId?: number,
    options?: AppLinksCommandOptions,
  ): Promise<AppLinksRead>;
  /** `pm set-app-links --package <pkg> <code> <domains|all>`. */
  setVerificationState(
    packageName: string,
    state: AppLinkSettableState,
    domains: AppLinkDomainSelector,
    options?: AppLinksCommandOptions,
  ): Promise<void>;
  /** `pm set-app-links-user-selection --user <id> --package <pkg> <enabled> <domains|all>`. */
  setUserSelection(
    packageName: string,
    userId: number,
    enabled: boolean,
    domains: AppLinkDomainSelector,
    options?: AppLinksCommandOptions,
  ): Promise<void>;
  /** `pm verify-app-links --re-verify <pkg>`: asks the verifier again; results arrive later. */
  reverify(packageName: string, options?: AppLinksCommandOptions): Promise<void>;
}

/** The device facts an app-links read or write needs besides the shell itself. */
export interface AppLinksTarget {
  appLinks: AppLinksDevice;
  apiLevel(signal?: AbortSignal): Promise<number | null>;
  /** Android's current (foreground) user. */
  currentUserId(signal?: AbortSignal): Promise<number>;
}

const domainArgs = (domains: AppLinkDomainSelector): string =>
  domains === "all" ? "all" : domains.map(shellQuote).join(" ");

/** {@link AppLinksDevice} over `adb shell pm`. */
export class AdbAppLinksDevice implements AppLinksDevice {
  constructor(private readonly adb: Pick<AdbExecutor, "executeCommand">) {}

  async read(
    packageName: string,
    userId?: number,
    options: AppLinksCommandOptions = {},
  ): Promise<AppLinksRead> {
    const userArg = userId === undefined ? "" : ` --user ${userId}`;
    const result = await this.adb.executeCommand(
      `shell pm get-app-links${userArg} ${shellQuote(packageName)}`,
      { noRetry: true, signal: options.signal, timeoutMs: options.timeoutMs },
    );
    const output = `${result.stdout}\n${result.stderr}`;
    if (appLinksOutputReportsUnsupported(output)) {
      return {
        found: false,
        kind: "unsupported",
        reason: "This device's package manager has no get-app-links command (Android 12+ only).",
      };
    }
    const snapshot = parseAppLinksOutput(result.stdout, packageName);
    if (snapshot) {
      return { found: true, snapshot };
    }
    const detail = output.trim();
    return {
      found: false,
      kind: detail ? "unreadable" : "noState",
      reason: detail
        ? `pm get-app-links reported no state for ${packageName}: ${detail}`
        : `${packageName} is not installed or declares no http(s) link domains.`,
    };
  }

  async setVerificationState(
    packageName: string,
    state: AppLinkSettableState,
    domains: AppLinkDomainSelector,
    options: AppLinksCommandOptions = {},
  ): Promise<void> {
    await this.run(
      `shell pm set-app-links --package ${shellQuote(packageName)} ${APP_LINK_SETTABLE_STATE_CODES[state]} ${domainArgs(domains)}`,
      options,
    );
  }

  async setUserSelection(
    packageName: string,
    userId: number,
    enabled: boolean,
    domains: AppLinkDomainSelector,
    options: AppLinksCommandOptions = {},
  ): Promise<void> {
    await this.run(
      `shell pm set-app-links-user-selection --user ${userId} --package ${shellQuote(packageName)} ${enabled} ${domainArgs(domains)}`,
      options,
    );
  }

  async reverify(packageName: string, options: AppLinksCommandOptions = {}): Promise<void> {
    await this.run(`shell pm verify-app-links --re-verify ${shellQuote(packageName)}`, options);
  }

  /** The write commands print nothing on success; pm reports refusals as `Error:`/exceptions. */
  private async run(command: string, options: AppLinksCommandOptions): Promise<void> {
    const result = await this.adb.executeCommand(command, {
      noRetry: true,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
    if (
      outputLooksLikeShellFailure(result.stdout, result.stderr) ||
      appLinksOutputReportsUnsupported(`${result.stdout}\n${result.stderr}`)
    ) {
      const detail = `${result.stdout}\n${result.stderr}`.trim();
      throw new ActionableError(`${command.replace(/^shell /, "")} failed: ${detail}`);
    }
  }
}

/** {@link AppLinksTarget} for one Android device over adb. */
export function createAdbAppLinksTarget(adb: AdbExecutor): AppLinksTarget {
  const resolver = new AndroidUserTargetResolver(adb);
  return {
    appLinks: new AdbAppLinksDevice(adb),
    apiLevel: (signal) => readAndroidDeviceApiLevel(adb, undefined, undefined, signal),
    currentUserId: async (signal) => (await resolver.resolve({ currentUser: true, signal })).userId,
  };
}
