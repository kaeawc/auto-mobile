import { z } from "zod/v4";
import { PLAN_RELEVANT } from "./toolRegistryTypes";
import { defineDeviceTool, type DeviceToolHandler } from "./defineTool";
import { displayProfileResultSchema } from "./displayProfileToolOutputSchemas";
import {
  runSessionDisplayProfileMutation,
  type SessionDisplayProfileHost,
} from "./sessionDisplayProfile";
import { createStructuredToolResponse } from "../utils/toolUtils";
import { defaultDaemonContext } from "../daemon/daemonContext";
import type { BootedDevice } from "../models";
import type { DeviceSettingKey } from "../models/DeviceSettingDefaults";
import {
  MAX_ANDROID_DENSITY_DPI,
  MIN_ANDROID_DENSITY_DPI,
} from "../features/utility/DisplayConfig";
import {
  applyDisplayProfile,
  CUTOUT_EMULATIONS,
  NAVIGATION_MODES,
  resetDisplayProfile,
  type DisplayProfileInput,
} from "../features/utility/DisplayProfile";
import {
  defaultDisplayProfileRestoreRegistry,
  type DisplayProfileRestoreRegistry,
} from "../features/utility/DisplayProfileRestore";
import {
  defaultDisplayProfilePortsFactory,
  type DisplayProfilePortsFactory,
} from "../features/utility/DisplayProfilePorts";
import { recordDeviceSettingDefaultsBeforeChange } from "../features/utility/DeviceSettingDefaults";
import { changedSettings } from "../features/utility/personaExecutors";

const displayProfileInput = z.object({
  action: z
    .enum(["apply", "reset"])
    .describe("apply the given fields, or reset every recorded change"),
  screenSize: z
    .string()
    .regex(/^(\d+x\d+|default)$/)
    .optional()
    .describe("wm size override WIDTHxHEIGHT, or 'default' to reset it"),
  density: z
    .union([
      z.number().min(MIN_ANDROID_DENSITY_DPI).max(MAX_ANDROID_DENSITY_DPI),
      z.enum(["smaller", "default", "larger"]),
    ])
    .optional()
    .describe("Display density dpi or bucket, as displayConfig (approximates Samsung Screen zoom)"),
  fontScale: z.number().min(0.1).max(10).optional().describe("System font scale, as displayConfig"),
  cutout: z
    .enum(CUTOUT_EMULATIONS)
    .optional()
    .describe("Display cutout emulation overlay, or none to disable it"),
  navigationMode: z.enum(NAVIGATION_MODES).optional().describe("Navigation bar overlay"),
  forceDark: z
    .boolean()
    .optional()
    .describe(
      "true forces dark rendering (debug.hwui.force_dark) and night mode, as OEM force dark",
    ),
  posture: z
    .enum(["closed", "half_opened", "opened", "rear_display", "flipped", "tent"])
    .optional()
    .describe("Fold posture, as setPosture (foldable AVDs and devices)"),
});

type DisplayProfileArgs = z.output<typeof displayProfileInput>;

export interface DisplayProfileToolDependencies {
  sessionManager?: () => SessionDisplayProfileHost | undefined;
  portsFor?: DisplayProfilePortsFactory;
  registry?: DisplayProfileRestoreRegistry;
  /** Records fontScale/density/nightMode defaults for the next-owner reset (#11145). */
  recordSettingDefaults?: (
    device: BootedDevice,
    keys: readonly DeviceSettingKey[],
  ) => Promise<void>;
}

function profileInput(args: DisplayProfileArgs): DisplayProfileInput {
  const { screenSize, density, fontScale, cutout, navigationMode, forceDark, posture } = args;
  return Object.fromEntries(
    Object.entries({
      screenSize,
      density,
      fontScale,
      cutout,
      navigationMode,
      forceDark,
      posture,
    }).filter(([, value]) => value !== undefined),
  );
}

export { changedSettings };

export const createDisplayProfileHandler =
  (deps: DisplayProfileToolDependencies = {}): DeviceToolHandler<typeof displayProfileInput> =>
  async (device, args, _progress, signal) => {
    const sessionManager = args.sessionUuid
      ? (deps.sessionManager ?? (() => defaultDaemonContext.sessionManager()))()
      : undefined;
    const ports = (deps.portsFor ?? defaultDisplayProfilePortsFactory)(device);
    const registry = deps.registry ?? defaultDisplayProfileRestoreRegistry;
    const input = profileInput(args);
    const result = await runSessionDisplayProfileMutation(
      sessionManager,
      args.sessionUuid,
      device.deviceId,
      async (owner) => {
        const profileDeps = { ...ports, registry, owner, signal };
        if (args.action === "reset") {
          return resetDisplayProfile(device, profileDeps);
        }
        await (deps.recordSettingDefaults ?? recordDeviceSettingDefaultsBeforeChange)(
          device,
          changedSettings(input),
        );
        return applyDisplayProfile(device, input, profileDeps);
      },
    );
    return createStructuredToolResponse({ success: true, ...result });
  };

const displayProfileTool = defineDeviceTool({
  name: "displayProfile",
  description:
    "Android: apply an OEM-style display persona in one call (screen size, density, font scale, display-cutout " +
    "and navigation-mode overlays, force dark, fold posture), composing displayConfig and setPosture. Each step " +
    "reports applied | partial | unsupported | failed. The state before each facet's first change is recorded once; " +
    "reset restores every recorded facet, and in a daemon session release or rebind does too. Approximates OEM " +
    "look and geometry; it cannot reproduce OEM SystemUI.",
  input: displayProfileInput,
  options: { ...PLAN_RELEVANT, defaultEnabled: false, outputSchema: displayProfileResultSchema },
});

export const displayProfileSchema = displayProfileTool.schema;

export function registerDisplayProfileTools(deps: DisplayProfileToolDependencies = {}): void {
  displayProfileTool.register(undefined, createDisplayProfileHandler(deps));
}
