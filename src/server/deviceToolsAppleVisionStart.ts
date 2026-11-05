import { ActionableError, type DeviceInfo } from "../models";
import {
  getDeviceToolsDependencies,
  mergeLegacyStartDevicePayload,
  reserveStableDeviceLifecycle,
  startDeviceParametersSchema,
  watchStartDeviceParametersSchema,
} from "../features/deviceLifecycle/deviceLifecycleCore";
import { combineAbortSignals, runWithAbortSignal } from "../utils/AbortContext";
import { DEFAULT_START_DEVICE_TIMEOUT_MS } from "../utils/deviceTimeouts";
import { createStructuredToolResponse } from "../utils/toolUtils";
import { describeDevice, projectBootedDevice } from "../daemon/deviceDescription";
import { runWithAcquisitionDeadline } from "./deviceToolsAcquisition";
import { bootAndBindHeadset } from "./deviceToolsAppleVisionProvision";
import { compareVersions } from "../utils/deviceMatcher";
import type { ListedAppleVision } from "../utils/ios-cmdline-tools/AppleVisionSimulatorBoot";
import type { BindBootedSession } from "./deviceToolsWatchOs";
import { stripInternalToolParams } from "./internalToolParams";
import { z } from "zod/v4";

// The registered startDevice input advertises these selectors for visionOS; every other
// Android/iOS option is refused by name. Without deviceId or name the selectors pick the headset.
const parameters = watchStartDeviceParametersSchema.omit({ enableTools: true }).extend({
  platform: z.literal("visionos"),
  formFactor: startDeviceParametersSchema.shape.formFactor,
  minOsVersion: startDeviceParametersSchema.shape.minOsVersion,
  maxOsVersion: startDeviceParametersSchema.shape.maxOsVersion,
  preferRunning: startDeviceParametersSchema.shape.preferRunning,
});

export function isAppleVisionStartRequest(rawArgs: object): boolean {
  const merged = mergeLegacyStartDevicePayload(rawArgs);
  return !!merged && typeof merged === "object" && Reflect.get(merged, "platform") === "visionos";
}

/** Boot an existing headset and bind at booted readiness, without iOS automation preparation. */
export async function startAppleVisionDevice(
  rawArgs: object,
  bindSession: BindBootedSession,
  signal?: AbortSignal,
) {
  const merged = mergeLegacyStartDevicePayload(stripInternalToolParams(rawArgs));
  const input = { ...(merged as Record<string, unknown>) };
  delete input.device;
  const parsed = parameters.safeParse(stripInternalToolParams(input));
  if (!parsed.success) {
    throw new ActionableError(
      `Invalid visionOS startDevice request: ${z.prettifyError(parsed.error)}`,
    );
  }
  const args = parsed.data;
  const deps = getDeviceToolsDependencies();
  const startedAtMs = deps.timer.now();
  return await runWithAcquisitionDeadline(
    startedAtMs + (args.timeoutMs ?? DEFAULT_START_DEVICE_TIMEOUT_MS),
    signal,
    {
      operationName: "startDevice",
      operation: async (deadlineMs, requestSignal, stage) =>
        await runWithAbortSignal(requestSignal, async () => {
          const find = async (signal: AbortSignal, selection: VisionStartSelection) => {
            signal.throwIfAborted();
            stage.current = "resolving the Apple Vision Pro simulator";
            const images = await deps.deviceManagerFactory().listDeviceImages("visionos", signal);
            return selectAppleVisionSimulator(images, selection);
          };
          const headset = await find(requestSignal, args);
          const lease = await reserveStableDeviceLifecycle(
            { platform: "visionos", stableId: headset.deviceId },
            { platform: "visionos", name: headset.name, deviceId: headset.deviceId },
            deps.timer,
            {
              deadlineMs,
              requestAbortSignal: requestSignal,
              operation: "start",
              coordinator: deps.lifecycleCoordinator,
            },
          );
          try {
            const lifecycleSignal =
              combineAbortSignals(requestSignal, lease.signal) ?? lease.signal;
            // A shutdown may have completed while this request waited for the lease.
            const fresh = await find(lifecycleSignal, { ...args, deviceId: headset.deviceId });
            if (fresh.deviceId !== headset.deviceId) {
              throw new ActionableError(
                "Apple Vision Pro simulator identity changed; retry with deviceId",
              );
            }
            const { boot, sessionId } = await bootAndBindHeadset(
              { headset: fresh, rawArgs, lease, bindSession, operation: "startDevice" },
              deps,
              deadlineMs,
              { signal: lifecycleSignal, stage },
            );
            return createStructuredToolResponse({
              message: `visionos '${boot.device.name}' is booted`,
              ...projectBootedDevice(
                describeDevice({
                  kind: "booted",
                  device: boot.device,
                  discovery: fresh,
                  session: { sessionId },
                }),
              ),
              isReady: true,
              acquisition: boot.acquisition,
              readiness: {
                level: "booted",
                checks: ["bootCompleted", "sessionBound"],
                elapsedMs: Math.max(0, deps.timer.now() - startedAtMs),
              },
            });
          } finally {
            lease.release();
          }
        }),
    },
  );
}

type VisionStartSelection = z.infer<typeof parameters>;

/**
 * The one headset the request selects. Exact deviceId and name, formFactor (only "xr-headset"
 * matches) and the inclusive OS range filter the listing. Several matches resolve to the single
 * running one when preferRunning (default true) allows it; otherwise the request is ambiguous.
 */
export function selectAppleVisionSimulator(
  images: DeviceInfo[],
  args: Omit<VisionStartSelection, "platform" | "timeoutMs" | "sessionUuid">,
): ListedAppleVision {
  const matches = images.filter(
    (headset): headset is ListedAppleVision =>
      headset.platform === "visionos" &&
      !!headset.deviceId &&
      (!args.deviceId || headset.deviceId === args.deviceId) &&
      (!args.name || headset.name === args.name) &&
      (!args.formFactor || args.formFactor === "xr-headset") &&
      withinOsRange(headset.osVersion, args.minOsVersion, args.maxOsVersion),
  );
  const running = matches.filter((headset) => headset.isRunning === true);
  const selected =
    matches.length === 1
      ? matches[0]
      : args.preferRunning !== false && running.length === 1
        ? running[0]
        : undefined;
  if (!selected) {
    throw new ActionableError(
      matches.length === 0
        ? "No Apple Vision Pro simulator matches the startDevice request; list them with automobile:devices/images/visionos"
        : `Apple Vision Pro simulator selection is ambiguous (${matches
            .map((headset) => `${headset.name} ${headset.deviceId}`)
            .join(", ")}); pass deviceId or name`,
    );
  }
  return selected;
}

function withinOsRange(
  osVersion: string | undefined,
  min: string | undefined,
  max: string | undefined,
): boolean {
  if (min === undefined && max === undefined) {
    return true;
  }
  if (!osVersion) {
    return false;
  }
  // compareVersions returns NaN for an unparseable pair, which fails both comparisons.
  return (
    (min === undefined || compareVersions(osVersion, min) >= 0) &&
    (max === undefined || compareVersions(osVersion, max) <= 0)
  );
}
