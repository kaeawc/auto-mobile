import { ActionableError } from "../../models/ActionableError";
import { DUMPSYS_MAX_BUFFER } from "../../utils/android-cmdline-tools/dumpsysLimits";
import { parseAndroidRuntimePermissions } from "../action/parseAndroidRuntimePermissions";
import {
  run,
  type Context,
  type StepPlan,
  type KillProfileBootObservation,
} from "./KillProfileStepPlan";

/** Receiver filters may repeat under several action indexes; report each component once. */
function bootReceivers(packageDump: string, appId: string): string[] {
  const receivers = new Set<string>();
  const table = packageDump.split("Receiver Resolver Table:")[1]?.split(/^\S/m)[0] ?? "";
  let component: string | undefined;
  for (const line of table.split("\n")) {
    const row = line.match(/^\s+\S+\s+(\S+\/\S+)\s+filter\b/);
    if (row) {
      component = row[1];
    }
    if (
      line.trim() === 'Action: "android.intent.action.BOOT_COMPLETED"' &&
      component?.startsWith(`${appId}/`)
    ) {
      receivers.add(component);
    }
  }
  return [...receivers];
}

export function parseBootObservation(
  packageDump: string,
  alarmDump: string,
  appId: string,
): KillProfileBootObservation {
  const permissions = parseAndroidRuntimePermissions(packageDump, appId);
  const stopped = packageDump.match(/^\s*User 0:.*\bstopped=(true|false)\b/m)?.[1];
  if (!permissions || stopped === undefined || !/^Current Alarm Manager state:/m.test(alarmDump)) {
    throw new ActionableError(`Could not read boot receiver or alarm state for ${appId}`);
  }
  const receivers = bootReceivers(packageDump, appId);
  const bootPermissionGranted =
    permissions.installPermissions.get("android.permission.RECEIVE_BOOT_COMPLETED")?.state ===
    "granted";
  const pendingAlarms = alarmDump.split("\n").filter((line) => {
    const row = line.match(/^\s+[A-Z_]+ #\d+: Alarm\{.* ([^\s}]+)\}$/);
    return row?.[1] === appId;
  }).length;
  return {
    bootReceivers: receivers,
    bootPermissionGranted,
    stopped: stopped === "true",
    bootBroadcastDelivered: receivers.length > 0 && bootPermissionGranted && stopped === "false",
    pendingAlarms,
  };
}

export function bootReceiverCheckPlan(context: Context): StepPlan {
  return {
    label: "boot receiver check",
    command: "",
    observe: async () => {
      const pkg = await run(context, `shell dumpsys package ${context.quoted}`, DUMPSYS_MAX_BUFFER);
      const alarms = await run(context, "shell dumpsys alarm", DUMPSYS_MAX_BUFFER);
      if (pkg.stderr.trim() || alarms.stderr.trim()) {
        throw new ActionableError(
          `Could not read boot receiver dumps: ${pkg.stderr} ${alarms.stderr}`,
        );
      }
      return parseBootObservation(pkg.stdout, alarms.stdout, context.appId);
    },
  };
}
