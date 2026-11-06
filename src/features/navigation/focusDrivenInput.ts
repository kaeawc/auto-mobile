/**
 * Focus-driven (D-pad) input for explore and navigateTo on Android TV (#16737).
 *
 * A TV app is walked the way a remote walks it: focus moves with the D-pad arrows and the
 * focused element is activated with select. Explore records that as one `focusNavigate`
 * call with `select: true`, so navigateTo replays the same D-pad moves; a `tapOn` edge
 * recorded elsewhere is replayed on a TV as the equivalent focus-and-select.
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
import type { ToolCallInteraction } from "../../utils/interfaces/NavigationGraph";
import { logger } from "../../utils/logger";
import type { FocusNavigateTarget } from "../action/FocusNavigate";
import { enrichElementWithChildProperties, tapSelectorFor } from "./ExploreElementExtraction";
import { asRecord } from "./ExploreValidateMode";

/** How explore and navigateTo address an element: by touch, or by D-pad focus and select. */
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

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** The focus target a recorded `tapOn` selector (`elementId` or `text`) names. */
export function focusTargetFromSelector(
  selector: Record<string, unknown>,
): FocusNavigateTarget | null {
  const resourceId = nonEmpty(selector.elementId);
  if (resourceId) {
    // tapOn accepts `pkg:id/name` for a control whose native id is just `name` (Compose);
    // focusNavigate matches a bare name against both, so keep only the name.
    const marker = resourceId.lastIndexOf(":id/");
    return { resourceId: marker >= 0 ? resourceId.slice(marker + ":id/".length) : resourceId };
  }
  // tapOn's text selector matches the text or the content-desc; `label` keeps that.
  const label = nonEmpty(selector.text);
  return label ? { label } : null;
}

/**
 * The focus target explore moves to for `element`: its resource id, else the label its tap
 * selector uses, matched on the property that label came from. Null when nothing names it, or
 * when the selector needs an occurrence index to tell duplicates apart.
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
  if ("elementId" in selector) {
    return { resourceId: selector.elementId };
  }
  const enriched = enrichElementWithChildProperties(element);
  const fromText = element.text === selector.text || enriched.text === selector.text;
  return fromText ? { text: selector.text } : { contentDesc: selector.text };
}

/** The recorded `focusNavigate` arguments that move focus to `until` and select it. */
export function focusSelectArgs(until: FocusNavigateTarget): {
  until: FocusNavigateTarget;
  select: true;
} {
  return { until, select: true };
}

/** `tapOn` arguments a D-pad select reproduces exactly. */
const PLAIN_TAP_ARGS: ReadonlySet<string> = new Set(["selector", "action", "elementId", "text"]);

/**
 * The D-pad replay of a recorded interaction on a TV: a plain `tapOn` by element id or text
 * becomes `focusNavigate` to that element with select (text as `label`, which also matches the
 * content-desc as tapOn does). Every other call (including a `focusNavigate` explore recorded,
 * a long press, a `container` scope, an occurrence `index`, or a coordinate tap) replays
 * unchanged.
 */
export function dpadReplayInteraction<T extends Pick<ToolCallInteraction, "toolName" | "args">>(
  interaction: T,
): T {
  if (interaction.toolName !== "tapOn") {
    return interaction;
  }
  const { args } = interaction;
  const selector = asRecord(args.selector) ?? args;
  // Only a plain tap converts: a container scope, occurrence index, duration (a long press)
  // or any other qualifier has no focusNavigate equivalent, so that call replays unchanged.
  const plainArgs = Object.keys(args).every((key) => PLAIN_TAP_ARGS.has(key));
  const plainSelector = Object.keys(selector).every((key) => PLAIN_TAP_ARGS.has(key));
  if (!plainArgs || !plainSelector || (args.action !== undefined && args.action !== "tap")) {
    return interaction;
  }
  const until = focusTargetFromSelector(selector);
  return until
    ? { ...interaction, toolName: "focusNavigate", args: focusSelectArgs(until) }
    : interaction;
}
