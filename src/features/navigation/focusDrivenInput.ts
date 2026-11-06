/**
 * Focus-driven (D-pad) input for explore on Android TV (#16737).
 *
 * A TV app is walked the way a remote walks it: focus moves with the D-pad arrows and the
 * focused element is activated with select. Explore records that as one `focusNavigate`
 * call with `select: true`, so navigateTo replays the same D-pad moves.
 */

import type { BootedDevice, Element, ViewHierarchyResult } from "../../models";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import {
  defaultDeviceTraits,
  type DeviceTraits,
} from "../../utils/android-cmdline-tools/deviceTraits";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type { FocusNavigateTarget } from "../action/FocusNavigate";
import { tapSelectorFor } from "./ExploreElementExtraction";

/** How explore addresses an element: by touch, or by D-pad focus and select. */
export type InteractionInputMode = "touch" | "dpad";

/** Resolves the device's input mode once it is needed; touch unless the device is a TV. */
export type InputModeResolver = () => Promise<InteractionInputMode>;

export const touchInputMode: InputModeResolver = async () => "touch";

/** Bound on each build-prop read of the TV probe. */
const INPUT_MODE_TRAITS_TIMEOUT_MS = 3_000;

/**
 * The input mode of `device`, read once and remembered: D-pad when the device is known to be a
 * TV (its form factor, else the build's `ro.build.characteristics`), touch otherwise. A failed
 * read is logged and leaves the device on touch, today's behaviour.
 */
export function deviceInputModeResolver(
  device: BootedDevice,
  {
    traits = defaultDeviceTraits,
    adbFactory = defaultAdbClientFactory,
  }: { traits?: DeviceTraits; adbFactory?: AdbClientFactory } = {},
): InputModeResolver {
  let resolved: Promise<InteractionInputMode> | undefined;
  const read = async (): Promise<InteractionInputMode> => {
    if (device.formFactor === "tv") {
      return "dpad";
    }
    if (device.platform !== "android") {
      return "touch";
    }
    try {
      const read = await traits.read(adbFactory.create(device), device.deviceId, {
        timeoutMs: INPUT_MODE_TRAITS_TIMEOUT_MS,
      });
      return read.formFactor === "tv" ? "dpad" : "touch";
    } catch (error) {
      logger.warn(
        `[FocusDrivenInput] Could not read device traits for ${device.deviceId}; using touch input: ${errorMessage(error)}`,
        error,
      );
      return "touch";
    }
  };
  return () => (resolved ??= read());
}

/**
 * The focus target explore moves to for `element`: its tap selector's element id or text, as
 * `elementId` or `label`. Null when nothing names it, or when the selector needs an occurrence
 * index to tell duplicates apart.
 */
export function focusTargetForElement(
  element: Element,
  hierarchy: ViewHierarchyResult,
): FocusNavigateTarget | null {
  const selector = tapSelectorFor(element, hierarchy);
  if (!selector) {
    return null;
  }
  if (selector.index !== undefined) {
    // focusNavigate has no occurrence index, so a duplicate would select the wrong one.
    return null;
  }
  // Named as tapOn names it, so the walk pins the element tapOn would tap (see pinnedFocusOptions).
  return "elementId" in selector ? { elementId: selector.elementId } : { label: selector.text };
}

/** The recorded `focusNavigate` arguments that move focus to `until` and select it. */
export function focusSelectArgs(until: FocusNavigateTarget): {
  until: FocusNavigateTarget;
  select: true;
} {
  return { until, select: true };
}
