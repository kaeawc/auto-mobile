import type { KillProfileStep } from "./KillProfiles";
import { bootReceiverCheckPlan } from "./KillProfileObservationPlans";
import { ActionableError } from "../../models/ActionableError";
import { DUMPSYS_MAX_BUFFER } from "../../utils/android-cmdline-tools/dumpsysLimits";
import { parseResumedActivityForDisplay } from "../../utils/android-cmdline-tools/parseResumedActivity";
import { shellQuote } from "../../utils/shellQuote";
import { defaultTimer } from "../../utils/SystemTimer";
import { throwIfAborted } from "../../utils/toolUtils";
import { parseAndroidRuntimePermissions } from "../action/parseAndroidRuntimePermissions";
import { run, type Context, type StepPlan } from "./KillProfileStepPlan";

async function grantedPermissions(context: Context): Promise<string[]> {
  const { stdout } = await run(
    context,
    `shell dumpsys package ${context.quoted}`,
    DUMPSYS_MAX_BUFFER,
  );
  const permissions = parseAndroidRuntimePermissions(stdout, context.appId);
  if (!permissions) {
    throw new ActionableError(`Could not read runtime permissions for ${context.appId}`);
  }
  return [...permissions.runtimePermissions].flatMap(([name, permission]) =>
    permission.state === "granted" ? [name] : [],
  );
}

/** AdbClient keeps the entire shell tail as one argument; && preserves command failures. */
function permissionCommands(
  context: Context,
  verb: "grant" | "revoke",
  permissions: string[],
): string {
  return permissions.length === 0
    ? ""
    : `shell ${permissions
        .map((permission) => `pm ${verb} ${context.quoted} ${shellQuote(permission)}`)
        .join(" && ")}`;
}

export function runtimePermissionsPlan(context: Context): StepPlan {
  let targeted: string[] = [];
  return {
    label: "runtime permissions revoke",
    get command() {
      return permissionCommands(context, "revoke", targeted);
    },
    minApi: 23,
    retainOnWriteFailure: true,
    retainOnVerificationFailure: true,
    capture: async () => {
      targeted = await grantedPermissions(context);
      return {
        key: `runtimePermissions:${context.appId}`,
        appId: context.appId,
        command: permissionCommands(context, "grant", targeted) || null,
      };
    },
    verify: async () => {
      const granted = new Set(await grantedPermissions(context));
      const remaining = targeted.filter((permission) => granted.has(permission));
      return remaining.length
        ? `Runtime permissions still granted: ${remaining.join(", ")}`
        : undefined;
    },
  };
}

export function foregroundChangePlan(context: Context): StepPlan {
  return {
    label: "foreground change",
    command: "shell am start -a android.settings.SETTINGS",
    verify: async () => {
      const { stdout } = await run(
        context,
        "shell dumpsys activity activities",
        DUMPSYS_MAX_BUFFER,
      );
      // Require the top-resumed signal, rather than accepting a legacy resumed activity.
      const top = stdout
        .split("\n")
        .filter((line) => /^\s*topResumedActivity\s*=/.test(line))
        .join("\n");
      const observed = parseResumedActivityForDisplay(top).activity?.packageName;
      if (!observed) {
        return "top resumed activity reads back as unreadable";
      }
      return observed === context.appId ? "app is still the top resumed activity" : undefined;
    },
  };
}

async function wakefulness(context: Context): Promise<string> {
  const { stdout } = await run(context, "shell dumpsys power", DUMPSYS_MAX_BUFFER);
  const observed = stdout.match(/\bmWakefulness=(\w+)/)?.[1];
  if (!observed) {
    throw new ActionableError("Could not read screen wakefulness");
  }
  return observed;
}

export function screenOffPlan(context: Context, minutes: number): StepPlan {
  return {
    label: `screen off ${minutes} minute(s)`,
    command: "shell input keyevent KEYCODE_SLEEP",
    retainOnVerificationFailure: true,
    capture: async () => ({
      key: "screen",
      command:
        (await wakefulness(context)) === "Awake" ? "shell input keyevent KEYCODE_WAKEUP" : null,
    }),
    verify: async () => {
      const timer = context.deps.timer ?? defaultTimer;
      let observed = "";
      for (let attempt = 0; attempt < 10; attempt++) {
        throwIfAborted(context.deps.signal);
        observed = await wakefulness(context);
        throwIfAborted(context.deps.signal);
        if (observed === "Asleep") {
          return undefined;
        }
        if (attempt < 9) {
          await timer.sleep(500);
        }
      }
      return `wakefulness reads back as ${observed}, expected Asleep`;
    },
    afterVerify: async () => {
      const timer = context.deps.timer ?? defaultTimer;
      for (let remaining = minutes * 60_000; remaining > 0;) {
        throwIfAborted(context.deps.signal);
        const chunk = Math.min(remaining, 10_000);
        await timer.sleep(chunk);
        remaining -= chunk;
      }
      throwIfAborted(context.deps.signal);
    },
  };
}

/** The OEM extensions share the same capture/write/verify runner as the original steps. */
export function oemStepPlan(
  context: Context,
  step: Extract<
    KillProfileStep,
    { kind: "runtimePermissions" | "foregroundChange" | "screenOff" | "bootReceiverCheck" }
  >,
): StepPlan {
  switch (step.kind) {
    case "runtimePermissions":
      return runtimePermissionsPlan(context);
    case "foregroundChange":
      return foregroundChangePlan(context);
    case "screenOff":
      return screenOffPlan(context, step.minutes);
    case "bootReceiverCheck":
      return bootReceiverCheckPlan(context);
  }
}
