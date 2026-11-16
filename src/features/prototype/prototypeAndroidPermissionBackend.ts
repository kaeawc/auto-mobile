import { ActionableError } from "../../models/ActionableError";
import type { ExecResult } from "../../models";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { DUMPSYS_MAX_BUFFER } from "../../utils/android-cmdline-tools/dumpsysLimits";
import { outputLooksLikeShellFailure } from "../../utils/android-cmdline-tools/shellOutputHeuristics";
import { shellQuote } from "../../utils/shellQuote";
import { parseAndroidRuntimePermissions } from "../action/parseAndroidRuntimePermissions";
import { parseNotificationAppOpMode } from "../action/SetAndroidNotificationsEnabled";
import type { PrototypePermissionBackend } from "./prototypePermissionGrants";
import type {
  PrototypePermissionMapping,
  PrototypePermissionName,
  PrototypePermissionState,
} from "./prototypePermissionMap";

/** POST_NOTIFICATIONS is a runtime permission from API 33; older devices use the appop. */
const RUNTIME_NOTIFICATIONS_MIN_API = 33;

function throwOnShellFailure(command: string, result: Pick<ExecResult, "stdout" | "stderr">): void {
  const stderr = result.stderr ?? "";
  if (outputLooksLikeShellFailure(result.stdout, stderr)) {
    throw new ActionableError(
      `\`${command}\` failed: ${`${result.stdout}\n${stderr}`.trim() || "no output"}`,
    );
  }
}

/** Folds the per-manifest-permission states of one canonical name into one state. */
function foldAndroidStates(
  states: readonly { granted: boolean; flags: string }[],
): PrototypePermissionState {
  const granted = states.filter((state) => state.granted).length;
  if (granted === states.length) {
    return "granted";
  }
  // Partial grants are the approximate-location and single-media-type cases.
  if (granted > 0) {
    return "limited";
  }
  if (states.some((state) => state.flags.includes("USER_FIXED"))) {
    return "blocked";
  }
  return states.some((state) => state.flags.includes("USER_SET")) ? "denied" : "notDetermined";
}

/**
 * Android half of #14297. A grant clears `user-set|user-fixed` and runs `pm grant`; a deny runs
 * `pm revoke` and sets `user-set|user-fixed`, so the app reads `blocked` and the next request
 * shows no dialog. Before API 33 notifications go through the POST_NOTIFICATION appop.
 */
export class AndroidPrototypePermissionBackend implements PrototypePermissionBackend {
  readonly target = "android";

  constructor(
    private readonly adb: Pick<AdbExecutor, "executeCommand">,
    private readonly options: { packageName: string; userId: number; apiLevel: number },
  ) {}

  async grant(_name: PrototypePermissionName, mapping: PrototypePermissionMapping): Promise<void> {
    if (this.usesNotificationAppOp(mapping)) {
      await this.shell(`cmd appops set ${this.quotedPackage} POST_NOTIFICATION allow`);
      return;
    }
    for (const permission of mapping.android.manifest) {
      await this.pm(`clear-permission-flags`, permission, " user-set user-fixed");
      await this.pm("grant", permission);
    }
  }

  async deny(_name: PrototypePermissionName, mapping: PrototypePermissionMapping): Promise<void> {
    if (this.usesNotificationAppOp(mapping)) {
      await this.shell(`cmd appops set ${this.quotedPackage} POST_NOTIFICATION deny`);
      return;
    }
    for (const permission of mapping.android.manifest) {
      await this.pm("revoke", permission);
      await this.pm("set-permission-flags", permission, " user-set user-fixed");
    }
  }

  async read(
    _name: PrototypePermissionName,
    mapping: PrototypePermissionMapping,
  ): Promise<PrototypePermissionState> {
    // No runtime permission exists (photosAdd writes through MediaStore), so it is always usable.
    if (mapping.android.grant === "none") {
      return "granted";
    }
    if (this.usesNotificationAppOp(mapping)) {
      const mode = parseNotificationAppOpMode(
        await this.shell(`cmd appops get ${this.quotedPackage} POST_NOTIFICATION`),
      );
      // Before API 33 notifications are on until the user turns them off.
      return mode === "deny" || mode === "ignore" ? "blocked" : "granted";
    }
    const dump = parseAndroidRuntimePermissions(
      await this.shell(`dumpsys package ${this.quotedPackage}`, DUMPSYS_MAX_BUFFER),
      this.options.packageName,
      this.options.userId,
    );
    if (dump === undefined) {
      throw new ActionableError(
        `Package ${this.options.packageName} is not installed for Android user ${this.options.userId}; install the prototype before setting its permissions`,
      );
    }
    const requested = mapping.android.manifest.filter((permission) =>
      dump.requestedPermissions.has(permission),
    );
    // The app does not declare any of the name's permissions, so it can never be granted.
    if (requested.length === 0) {
      return "unavailable";
    }
    return foldAndroidStates(
      requested.map((permission) => {
        const state =
          dump.runtimePermissions.get(permission) ?? dump.installPermissions.get(permission);
        const flags = state?.raw?.flags;
        return {
          granted: state?.state === "granted",
          flags: typeof flags === "string" ? flags : "",
        };
      }),
    );
  }

  private get quotedPackage(): string {
    return shellQuote(this.options.packageName);
  }

  private usesNotificationAppOp(mapping: PrototypePermissionMapping): boolean {
    return (
      mapping.android.grant === "notifications" &&
      this.options.apiLevel < RUNTIME_NOTIFICATIONS_MIN_API
    );
  }

  private async pm(verb: string, permission: string, suffix = ""): Promise<void> {
    await this.shell(
      `pm ${verb} --user ${this.options.userId} ${this.quotedPackage} ${shellQuote(permission)}${suffix}`,
    );
  }

  private async shell(command: string, maxBuffer?: number): Promise<string> {
    const result = await this.adb.executeCommand(`shell ${command}`, {
      noRetry: true,
      ...(maxBuffer === undefined ? {} : { maxBuffer }),
    });
    throwOnShellFailure(command, result);
    return result.stdout;
  }
}
