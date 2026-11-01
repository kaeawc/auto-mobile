import type { BootedDevice, ViewHierarchyResult } from "../../models";
import { unsupportedPlatformError } from "../../models/ActionableError";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { Timer } from "../../utils/SystemTimer";
import type { ViewHierarchy } from "../observe/ViewHierarchy";
import type { AndroidCtrlProxy, AndroidCtrlProxyClient } from "../observe/android";
import { IOSCtrlProxyClient } from "../observe/ios";
import { iosHierarchyAcquisition } from "../observe/ios/types";
import {
  deviceIosSdkBridgeReader,
  mergeIosSdkBridgeInto,
  type IosSdkBridgeReader,
} from "../observe/ios/IosSdkBridgeReader";
import {
  deviceIosSdkWebReader,
  mergeIosSdkWebInto,
  type IosSdkWebReader,
} from "../observe/ios/IosSdkWebReader";
import { refreshAndroidViewHierarchy } from "./refreshAndroidViewHierarchy";

/** Hierarchy-read helpers shared by TapOnElement and TapAnyElement (#11832). */

/**
 * True when the raw tree must be returned as-is: raw element search is off, or the tree is a
 * captured error. Callers filter the tree for the response only when this is false.
 */
export function returnsRawHierarchyUnfiltered(
  rawElementSearchEnabled: boolean,
  rawHierarchy: ViewHierarchyResult,
): boolean {
  if (!rawElementSearchEnabled) {
    return true;
  }
  const tree = rawHierarchy?.hierarchy;
  return Boolean(tree && typeof tree === "object" && "error" in tree && tree.error);
}

/** The CtrlProxy surface TapOnElement calls: the shared interface plus the client-only hierarchy overload. */
export type TapOnCtrlProxy = AndroidCtrlProxy &
  Pick<AndroidCtrlProxyClient, "getAccessibilityHierarchy">;

export interface FreshHierarchyReadDeps {
  device: BootedDevice;
  adb: AdbExecutor;
  timer: Timer;
  /** CtrlProxy client used for the Android read (the two tools hold different fields). */
  androidService: AndroidCtrlProxy;
  viewHierarchy: ViewHierarchy;
  /** Filter a raw tree for the response (platform-specific, owned by each tool). */
  prepareForResponse: (
    raw: ViewHierarchyResult,
    screenSize?: { width: number; height: number },
  ) => ViewHierarchyResult;
  /** Names the action in the unsupported-platform error. */
  actionLabel: string;
  /** The app's SDK observation bridge (#5159); defaults to the device's runner client. */
  sdkBridge?: IosSdkBridgeReader;
  /** The app's opted-in WKWebView bridges (#5162); defaults to the device's runner client. */
  sdkWeb?: IosSdkWebReader;
}

/** Read one fresh hierarchy for the device platform within `timeoutMs`; null when none arrived. */
export async function readFreshPlatformHierarchy(
  deps: FreshHierarchyReadDeps,
  request: {
    timeoutMs: number;
    screenSize?: { width: number; height: number };
    signal?: AbortSignal;
    forceCapture: boolean;
  },
): Promise<ViewHierarchyResult | null> {
  const { device } = deps;
  const { signal, screenSize } = request;
  const effectiveTimeoutMs = Math.max(0, request.timeoutMs);
  const deadline = deps.timer.now() + effectiveTimeoutMs;
  switch (device.platform) {
    case "android": {
      const rawHierarchy = await refreshAndroidViewHierarchy(
        deps.androidService,
        effectiveTimeoutMs,
        signal,
        { adb: deps.adb, timer: deps.timer },
      );
      return rawHierarchy ? deps.prepareForResponse(rawHierarchy, screenSize) : null;
    }
    case "ios": {
      // Direct sync bypasses the client TTL while retaining the search deadline. Match the
      // observe projection exactly: CtrlProxy's alternate conversion would let a selector
      // observed from one tree resolve against a differently-pruned tree on refresh.
      const client = IOSCtrlProxyClient.getInstance(device);
      const synced = request.forceCapture
        ? await client.requestHierarchySyncForTapRevalidation(
            undefined,
            false,
            signal,
            effectiveTimeoutMs,
          )
        : await client.requestHierarchySync(undefined, false, signal, {
            timeoutMs: effectiveTimeoutMs,
          });
      if (!synced?.hierarchy) {
        return null;
      }
      const rawHierarchy = deps.viewHierarchy.normalizeIosHierarchy(
        client.convertToViewHierarchyResult(synced.hierarchy),
      );
      const acquisition = synced[iosHierarchyAcquisition];
      if (acquisition === "device" || acquisition === "client-cache") {
        Object.assign(rawHierarchy, { [iosHierarchyAcquisition]: acquisition });
      }
      const prepared = deps.prepareForResponse(rawHierarchy, screenSize);
      // Merge the bridges exactly as observe does, so a revalidated target keeps its bridge or
      // web identity.
      await mergeIosSdkBridgeInto(
        prepared,
        deps.sdkBridge ?? deviceIosSdkBridgeReader(device, deps.timer),
        signal,
        Math.max(0, deadline - deps.timer.now()),
      );
      await mergeIosSdkWebInto(
        prepared,
        deps.sdkWeb ?? deviceIosSdkWebReader(device, deps.timer),
        signal,
        Math.max(0, deadline - deps.timer.now()),
      );
      return prepared;
    }
    default:
      throw unsupportedPlatformError(device.platform, deps.actionLabel);
  }
}
