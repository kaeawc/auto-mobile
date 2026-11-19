import type { BootedDevice } from "../models";
import { ActionableError, toActionableError } from "../models/ActionableError";
import type { CarPlayObservation } from "../models/WatchObservation";
import { SimCtlClient } from "../utils/ios-cmdline-tools/SimCtlClient";
import { findCarPlayScreen } from "../utils/ios-cmdline-tools/SimulatorDisplays";
import { isIosSimulatorUdid } from "../utils/ios-cmdline-tools/iosDeviceType";
import {
  DefaultCarPlayProjectionProbe,
  requireCarPlayProjection,
  type CarPlayProjectionProbe,
} from "../utils/ios/carPlayProjection";
import { createObserveResponse, type ObserveResponse } from "./observeResponse";
import type { ObserveArgs } from "./observeTools";
import {
  captureRetainedObservePng,
  requireObservePngSize,
  unsupportedScreenshotOnlyObserveOptions,
  type RetainedObservePngDependencies,
} from "./observeWatch";

export interface CarPlayObserveDependencies extends RetainedObservePngDependencies {
  projectionProbe?: CarPlayProjectionProbe;
  simctl?: Pick<SimCtlClient, "enumerateScreens" | "screenshot">;
}

const defaultProjectionProbe = new DefaultCarPlayProjectionProbe();

export async function observeCarPlay(
  device: BootedDevice,
  args: ObserveArgs,
  signal: AbortSignal | undefined,
  dependencies: CarPlayObserveDependencies = {},
): Promise<ObserveResponse<CarPlayObservation>> {
  const refused = unsupportedScreenshotOnlyObserveOptions(args);
  if (refused.length > 0) {
    throw new ActionableError(
      `CarPlay observe returns only a screenshot and does not support ${refused.join(", ")}. Remove the unsupported options and observe again.`,
    );
  }

  const { deviceId } = device;
  if (!isIosSimulatorUdid(deviceId)) {
    throw new ActionableError('display: "carplay" requires an iOS simulator.');
  }
  signal?.throwIfAborted();
  await requireCarPlayProjection(deviceId, dependencies.projectionProbe ?? defaultProjectionProbe);
  signal?.throwIfAborted();

  const simctl = dependencies.simctl ?? new SimCtlClient(device);
  let screen;
  try {
    const screens = await simctl.enumerateScreens(deviceId, undefined, signal);
    screen = findCarPlayScreen(screens.auxiliary);
  } catch (error) {
    throw toActionableError(error, `Failed to list CarPlay screens on iOS simulator ${deviceId}`);
  }
  if (!screen) {
    throw new ActionableError(
      `Expected one named CarPlay screen on iOS simulator ${deviceId}. Open the CarPlay window in Simulator.app, confirm that exactly one CarPlay screen is connected, and observe again.`,
    );
  }
  signal?.throwIfAborted();

  const { capture, protection } = await captureRetainedObservePng(
    deviceId,
    async () => {
      let png: Buffer;
      try {
        png = await simctl.screenshot(deviceId, screen.name, signal);
      } catch (error) {
        throw toActionableError(error, `Failed to capture CarPlay on iOS simulator ${deviceId}`);
      }
      return { png, ...requireObservePngSize(png, `CarPlay on iOS simulator ${deviceId}`) };
    },
    { ...dependencies, signal, label: "CarPlay screenshot" },
  );
  const result: CarPlayObservation = {
    ...capture,
    display: { key: "carplay", role: "external", posture: "unknown", generation: 0 },
    hierarchyUnavailable: {
      platform: "ios",
      message: "CarPlay has no runner hierarchy. Read the screenshot to see the CarPlay screen.",
    },
  };
  return createObserveResponse(result, args.includeScreenshotImage, { signal, protection });
}
