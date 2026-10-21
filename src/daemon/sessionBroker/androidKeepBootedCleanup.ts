import { ActionableError } from "../../models/ActionableError";
import { isDeepStrictEqual } from "node:util";
import { parseAndroidRuntimePermissions } from "../../features/action/parseAndroidRuntimePermissions";
import { shellQuote } from "../../utils/shellQuote";
import { logger } from "../../utils/logger";
import {
  ANDROID_BASELINE_FILE_ROOTS,
  captureAndroidUsers,
  isAndroidResetFile,
  observeSettings,
  parseAndroidBaselinePackages,
  type AndroidBaselineCommand,
} from "./androidMutationBaseline";
import type { DeviceMutationResetContext } from "./mutations/reset";
import type { DeviceBaseline, DeviceMutationInput, MutationValue } from "./mutations/types";

export function isAndroidCriticalSetting(key: string): boolean {
  return /^(?:global|secure):(?:user:\d+:)?(?:adb_enabled|adb_wifi_enabled|development_settings_enabled|airplane_mode_on|wifi_on|mobile_data|enabled_accessibility_services|accessibility_enabled)$/.test(
    key,
  );
}

export async function cleanAndroidBaseline(
  baseline: DeviceBaseline,
  context: DeviceMutationResetContext,
  command: AndroidBaselineCommand,
  revert: (mutation: DeviceMutationInput) => Promise<void>,
): Promise<void> {
  await new AndroidBaselineCleaner(baseline, context, command, revert).clean();
}

class AndroidBaselineCleaner {
  private readonly prior: ReadonlyMap<string, MutationValue>;

  constructor(
    private readonly baseline: DeviceBaseline,
    private readonly context: DeviceMutationResetContext,
    private readonly command: AndroidBaselineCommand,
    private readonly revert: (mutation: DeviceMutationInput) => Promise<void>,
  ) {
    this.prior = new Map(
      baseline.observations.map((observation) => [
        `${observation.kind}:${observation.key}`,
        observation.value,
      ]),
    );
  }

  private restore(kind: string, key: string, priorValue: MutationValue): Promise<void> {
    return this.revert({ kind, key, priorValue, toolName: "keep-booted-cleaning" });
  }

  async clean(): Promise<void> {
    const users = await captureAndroidUsers(this.command);
    await this.cleanPackages(users);
    for (const namespace of ["global", "system", "secure"]) {
      for (const user of namespace === "global" ? [0] : users) {
        await this.cleanSettings(namespace, user);
      }
    }
    await this.cleanFiles();
  }

  private async cleanPackages(users: readonly number[]): Promise<void> {
    for (const user of users) {
      const packages = parseAndroidBaselinePackages(
        await this.command(`shell pm list packages -3 --user ${user}`),
      );
      for (const packageName of packages) {
        await this.cleanPackage(user, packageName);
      }
    }
  }

  private async cleanPackage(user: number, packageName: string): Promise<void> {
    const key = `user:${user}:${packageName}`;
    if (this.prior.get(`installed-app:${key}`)?.state !== "present") {
      await this.restore("installed-app", key, { state: "absent" });
      return;
    }
    const dump = await this.command(`shell dumpsys package ${shellQuote(packageName)}`);
    const permissions = parseAndroidRuntimePermissions(dump, packageName, user);
    if (!permissions) {
      throw new ActionableError(`Android cleaning cannot read runtime permissions for ${key}`);
    }
    for (const [permission, state] of permissions.runtimePermissions) {
      const permissionKey = `runtime:${user}:${packageName}:${permission}`;
      const baselineGrant = this.prior.get(`permission:${permissionKey}`);
      if (
        state.state === "granted" &&
        !(baselineGrant?.state === "present" && baselineGrant.value === true)
      ) {
        await this.restore("permission", permissionKey, { state: "present", value: false });
      }
    }
  }

  private async cleanSettings(namespace: string, user: number): Promise<void> {
    const current = new Map<string, MutationValue>();
    observeSettings(
      await this.command(`shell settings --user ${user} list ${namespace}`),
      namespace,
      user,
      (_kind, key, value) => {
        current.set(key, value === null ? { state: "absent" } : { state: "present", value });
      },
    );
    const prefix = user === 0 ? `${namespace}:` : `${namespace}:user:${user}:`;
    const baselineSettings = this.baseline.observations.filter(
      (observation) =>
        observation.kind === "device-setting" &&
        observation.key.startsWith(prefix) &&
        (user !== 0 || !observation.key.startsWith(`${namespace}:user:`)),
    );
    for (const key of new Set([...current.keys(), ...baselineSettings.map((entry) => entry.key)])) {
      const previous = this.prior.get(`device-setting:${key}`) ?? { state: "absent" };
      if (isDeepStrictEqual(current.get(key) ?? { state: "absent" }, previous)) {
        continue;
      }
      try {
        await this.restore("device-setting", key, previous);
      } catch (error) {
        logger.warn(`Android cleaning could not restore setting ${key}`, error);
        await this.context.assertOwned();
        this.context.signal.throwIfAborted();
        if (isAndroidCriticalSetting(key)) {
          throw error;
        }
      }
    }
  }

  private async cleanFiles(): Promise<void> {
    for (const root of ANDROID_BASELINE_FILE_ROOTS) {
      const script = `if [ -d ${shellQuote(root)} ]; then find ${shellQuote(root)} -type f -print; elif [ -e ${shellQuote(root)} ]; then exit 1; fi`;
      const paths = (await this.command(`shell sh -c ${shellQuote(script)}`))
        .split("\n")
        .filter(Boolean);
      for (const path of paths) {
        if (!path.startsWith(`${root}/`) || !isAndroidResetFile(path)) {
          throw new ActionableError("Android cleaning shared-file inventory is malformed");
        }
        if (this.prior.get(`shared-file:${path}`)?.state !== "present") {
          await this.restore("shared-file", path, { state: "absent" });
        }
      }
    }
  }
}
