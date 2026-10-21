import { z } from "zod/v4";
import { PLAN_RELEVANT } from "./toolRegistryTypes";
import { defineDeviceTool, type DeviceToolHandler } from "./defineTool";
import { killProfileResultSchema } from "./killProfileToolOutputSchemas";
import { runSessionKillProfileMutation, type SessionKillProfileHost } from "./sessionKillProfile";
import { createStructuredToolResponse } from "../utils/toolUtils";
import { defaultDaemonContext } from "../daemon/daemonContext";
import { ActionableError } from "../models/ActionableError";
import type { BootedDevice } from "../models";
import {
  KILL_PROFILE_IDS,
  KILL_PROFILE_NON_EMULATABLE,
  KILL_PROFILES,
} from "../features/utility/KillProfiles";
import {
  defaultKillProfileRestoreRegistry,
  defaultKillProfileShellFactory,
  type KillProfileRestoreRegistry,
  type KillProfileShellFactory,
} from "../features/utility/KillProfileRestore";
import {
  applyKillProfile,
  resetKillProfile,
  type ApplyKillProfileResult,
  type ResetKillProfileResult,
} from "../features/utility/ApplyKillProfile";

const killProfileInput = z.object({
  action: z
    .enum(["apply", "reset", "list"])
    .describe(
      "apply a profile, reset what profiles changed, or list the catalog (no device change)",
    ),
  appId: z.string().min(1).optional().describe("Android package; required for apply and reset"),
  profile: z.enum(KILL_PROFILE_IDS).optional().describe("Profile id; required for apply"),
  baseline: z
    .boolean()
    .optional()
    .describe(
      "reset only: when nothing is recorded (e.g. after a daemon restart), write the AOSP defaults",
    ),
});

type KillProfileArgs = z.output<typeof killProfileInput>;

export interface KillProfileToolDependencies {
  sessionManager?: () => SessionKillProfileHost | undefined;
  shellFor?: KillProfileShellFactory;
  registry?: KillProfileRestoreRegistry;
}

function listCatalog(device: BootedDevice) {
  return {
    message: `${KILL_PROFILE_IDS.length} kill profiles`,
    action: "list" as const,
    deviceId: device.deviceId,
    profiles: KILL_PROFILE_IDS.map((id) => KILL_PROFILES[id]),
    nonEmulatable: [...KILL_PROFILE_NON_EMULATABLE],
  };
}

function requireAppId(args: KillProfileArgs): string {
  if (!args.appId) {
    throw new ActionableError(`killProfile ${args.action} needs appId.`);
  }
  return args.appId;
}

export const createKillProfileHandler =
  (deps: KillProfileToolDependencies = {}): DeviceToolHandler<typeof killProfileInput> =>
  async (device, args, _progress, signal) => {
    if (args.action === "list") {
      return createStructuredToolResponse({ success: true, ...listCatalog(device) });
    }
    const appId = requireAppId(args);
    const profile = args.profile;
    if (args.action === "apply" && !profile) {
      throw new ActionableError("killProfile apply needs profile; list the ids with action: list.");
    }
    const sessionManager = args.sessionUuid
      ? (deps.sessionManager ?? (() => defaultDaemonContext.sessionManager()))()
      : undefined;
    const shellFor = deps.shellFor ?? defaultKillProfileShellFactory;
    const result = await runSessionKillProfileMutation(
      sessionManager,
      args.sessionUuid,
      device.deviceId,
      (owner): Promise<ApplyKillProfileResult | ResetKillProfileResult> => {
        const killDeps = {
          shell: shellFor(device),
          registry: deps.registry ?? defaultKillProfileRestoreRegistry,
          owner,
          signal,
        };
        return profile && args.action === "apply"
          ? applyKillProfile(device, appId, profile, killDeps)
          : resetKillProfile(device, appId, { baseline: args.baseline }, killDeps);
      },
    );
    return createStructuredToolResponse({ success: true, ...result });
  };

const killProfileTool = defineDeviceTool({
  name: "killProfile",
  description:
    "Android: simulate an OEM background-kill policy (Samsung sleeping apps, Xiaomi autostart off, OnePlus " +
    "deep optimization, recents swipe, Motorola adaptive battery, user-restricted, exact alarms denied) on a " +
    "stock device with standby buckets, appops, Doze and force-stop. Each profile reports its evidence status " +
    "and each step applied | unsupported | failed. apply is idempotent and records the state before the first " +
    "change; reset restores it, and in a daemon session release or rebind does too. list shows the catalog " +
    "and the OEM behaviour that cannot be simulated. Simulates effects, not firmware.",
  input: killProfileInput,
  options: {
    ...PLAN_RELEVANT,
    defaultEnabled: false,
    deviceReadOnly: (args: { action?: string }) => args.action === "list",
    deviceReadOnlyArgs: [{ argument: "action", values: ["list"] }],
    outputSchema: killProfileResultSchema,
  },
});

export const killProfileSchema = killProfileTool.schema;

export function registerKillProfileTools(deps: KillProfileToolDependencies = {}): void {
  killProfileTool.register(undefined, createKillProfileHandler(deps));
}
