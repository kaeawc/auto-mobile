import { z } from "zod/v4";
import { PLAN_RELEVANT } from "./toolRegistryTypes";
import { defineDeviceTool, type DeviceToolHandler } from "./defineTool";
import { personaResultSchema } from "./personaToolOutputSchemas";
import { runSessionPersonaMutation, type SessionPersonaHost } from "./sessionPersona";
import { changedSettings, type DisplayProfileToolDependencies } from "./displayProfileTools";
import { setKeyboardProfileForTool } from "./interactionToolHandlers";
import { createStructuredToolResponse, withIsErrorOnFailure } from "../utils/toolUtils";
import { defaultDaemonContext } from "../daemon/daemonContext";
import { ActionableError } from "../models/ActionableError";
import type { BootedDevice } from "../models";
import { KEYBOARD_PROFILE_IDS, type KeyboardProfileId } from "../features/action/keyboardProfiles";
import {
  NON_EMULATABLE_CAPABILITY_IDS,
  OEM_PERSONA_IDS,
  type OemPersonaId,
} from "../features/utility/OemPersonas";
import {
  applyPersona,
  describePersona,
  listPersonas,
  resetPersona,
  type ApplyPersonaResult,
  type PersonaFacetExecutors,
  type ResetPersonaResult,
  type RoutePersonaResult,
} from "../features/utility/ApplyPersona";
import {
  defaultPersonaRestoreRegistry,
  type PersonaRestoreRegistry,
} from "../features/utility/PersonaRestore";
import { applyKillProfile, resetKillProfile } from "../features/utility/ApplyKillProfile";
import {
  defaultKillProfileRestoreRegistry,
  defaultKillProfileShellFactory,
} from "../features/utility/KillProfileRestore";
import { applyDisplayProfile, resetDisplayProfile } from "../features/utility/DisplayProfile";
import { defaultDisplayProfileRestoreRegistry } from "../features/utility/DisplayProfileRestore";
import { defaultDisplayProfilePortsFactory } from "../features/utility/DisplayProfilePorts";
import { recordDeviceSettingDefaultsBeforeChange } from "../features/utility/DeviceSettingDefaults";

const personaInput = z.object({
  action: z
    .enum(["list", "describe", "apply", "reset"])
    .describe(
      "list the catalog or describe one manufacturer profile (no device change), apply one, or reset what manufacturer profiles changed",
    ),
  manufacturerProfile: z
    .enum(OEM_PERSONA_IDS)
    .optional()
    .describe("Manufacturer profile id; required for describe and apply"),
  appId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Android package the kill facet targets; required to apply a manufacturer profile with a kill profile",
    ),
  requires: z
    .array(z.enum(NON_EMULATABLE_CAPABILITY_IDS))
    .optional()
    .describe(
      "apply only: OEM capabilities the task needs; one the manufacturer profile cannot emulate returns route_to_real_device and changes nothing",
    ),
});

type PersonaArgs = z.output<typeof personaInput>;

export type PersonaExecutorsFactory = (
  device: BootedDevice,
  signal: AbortSignal | undefined,
) => PersonaFacetExecutors;

export interface PersonaToolDependencies {
  sessionManager?: () => SessionPersonaHost | undefined;
  executorsFor?: PersonaExecutorsFactory;
  registry?: PersonaRestoreRegistry;
}

function isKeyboardProfileId(value: string): value is KeyboardProfileId {
  return (KEYBOARD_PROFILE_IDS as readonly string[]).includes(value);
}

/** The production executors: `keyboard setProfile`, `killProfile` and `displayProfile`. */
export const defaultPersonaExecutors = (
  device: BootedDevice,
  signal: AbortSignal | undefined,
  recordSettingDefaults: NonNullable<
    DisplayProfileToolDependencies["recordSettingDefaults"]
  > = recordDeviceSettingDefaultsBeforeChange,
): PersonaFacetExecutors => {
  const killDeps = (owner?: string) => ({
    shell: defaultKillProfileShellFactory(device),
    registry: defaultKillProfileRestoreRegistry,
    owner,
    signal,
  });
  const displayDeps = (owner?: string) => ({
    ...defaultDisplayProfilePortsFactory(device),
    registry: defaultDisplayProfileRestoreRegistry,
    owner,
    signal,
  });
  return {
    keyboard: {
      set: (profile, setSignal) => {
        if (!isKeyboardProfileId(profile)) {
          throw new ActionableError(`Unknown keyboard profile '${profile}'.`);
        }
        return setKeyboardProfileForTool(device, profile, undefined, setSignal);
      },
    },
    kill: {
      apply: (appId, profile, owner) => applyKillProfile(device, appId, profile, killDeps(owner)),
      reset: (appId, owner) => resetKillProfile(device, appId, {}, killDeps(owner)),
      hasPending: (appId) =>
        defaultKillProfileRestoreRegistry
          .pendingFor(device.deviceId, appId)
          .some((action) => action.appId === appId),
    },
    display: {
      apply: async (input, owner) => {
        await recordSettingDefaults(device, changedSettings(input));
        return applyDisplayProfile(device, input, displayDeps(owner));
      },
      reset: (owner) => resetDisplayProfile(device, displayDeps(owner)),
    },
  };
};

function requirePersona(args: PersonaArgs): OemPersonaId {
  if (!args.manufacturerProfile) {
    throw new ActionableError(
      `manufacturerProfile ${args.action} needs manufacturerProfile; list the ids with action: list.`,
    );
  }
  return args.manufacturerProfile;
}

/**
 * The tool's public vocabulary is "manufacturer profile"; the catalog code keeps its persona
 * names. Rename the result keys at this boundary only.
 */
function toToolResult<T extends object>(result: T): Record<string, unknown> {
  const renamed: Record<string, string> = {
    persona: "manufacturerProfile",
    personaId: "manufacturerProfileId",
    personas: "manufacturerProfiles",
  };
  return Object.fromEntries(
    Object.entries(result).map(([key, value]) => [renamed[key] ?? key, value]),
  );
}

function readOnlyResult(device: BootedDevice, args: PersonaArgs) {
  if (args.action === "list") {
    const catalog = listPersonas();
    return toToolResult({
      message: `${catalog.personas.length} manufacturer profiles`,
      ...catalog,
    });
  }
  const description = describePersona(requirePersona(args));
  return toToolResult({
    message: `${description.persona.displayName} v${description.persona.version}: ${description.facets.length} facets`,
    ...description,
  });
}

export const createPersonaHandler =
  (deps: PersonaToolDependencies = {}): DeviceToolHandler<typeof personaInput> =>
  async (device, args, _progress, signal) => {
    if (args.action === "list" || args.action === "describe") {
      return createStructuredToolResponse({
        success: true,
        action: args.action,
        deviceId: device.deviceId,
        ...readOnlyResult(device, args),
      });
    }
    if (device.platform !== "android") {
      throw new ActionableError(
        "manufacturerProfile apply and reset are Android-only; select an Android device.",
      );
    }
    const personaId = args.action === "apply" ? requirePersona(args) : undefined;
    const sessionManager = args.sessionUuid
      ? (deps.sessionManager ?? (() => defaultDaemonContext.sessionManager()))()
      : undefined;
    const executors = (deps.executorsFor ?? defaultPersonaExecutors)(device, signal);
    const registry = deps.registry ?? defaultPersonaRestoreRegistry;
    const result = await runSessionPersonaMutation(
      sessionManager,
      args.sessionUuid,
      device.deviceId,
      (owner): Promise<ApplyPersonaResult | RoutePersonaResult | ResetPersonaResult> => {
        const personaDeps = { executors, registry, owner, signal };
        return personaId
          ? applyPersona(
              device,
              personaId,
              { appId: args.appId, requires: args.requires },
              personaDeps,
            )
          : resetPersona(device, { appId: args.appId }, personaDeps);
      },
    );
    const success = result.status !== "route_to_real_device";
    return withIsErrorOnFailure(
      createStructuredToolResponse({ success, ...toToolResult(result) }),
      success,
    );
  };

const personaTool = defineDeviceTool({
  name: "manufacturerProfile",
  description:
    "Android: apply an OEM manufacturer profile (pixel-baseline, samsung-oneui, xiaomi-hyperos, oneplus-oxygenos, " +
    "oppo-coloros, motorola) on a stock device by composing the keyboard profile, killProfile and displayProfile " +
    "executors. describe reports every facet's evidence status (focused_trace | vendor_documented | cdd_derived | " +
    "inferred | experimental) and the OEM capabilities that cannot be emulated; apply with requires naming one of " +
    "those returns route_to_real_device and changes nothing. applying a different manufacturer profile resets the " +
    "recorded one first; reset restores the display, kill and keyboard changes (display and device-wide kill state " +
    "are shared with displayProfile and killProfile). The keyboard profile persists until reset, even across " +
    "sessions. Simulates effects, not firmware.",
  input: personaInput,
  options: {
    ...PLAN_RELEVANT,
    defaultEnabled: false,
    deviceReadOnly: (args: { action?: string }) =>
      args.action === "list" || args.action === "describe",
    deviceReadOnlyArgs: [{ argument: "action", values: ["list", "describe"] }],
    outputSchema: personaResultSchema,
  },
});

export const personaSchema = personaTool.schema;

export function registerPersonaTools(deps: PersonaToolDependencies = {}): void {
  personaTool.register(undefined, createPersonaHandler(deps));
}
