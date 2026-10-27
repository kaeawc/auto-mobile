import { prototypeWindowMotionFields } from "./prototypeWindowMotion";
import { PROTOTYPE_WINDOW_MOTION_CAPABILITY } from "../observe/android/ctrlProxyProtocol";
import { prototypeEffectFields, prototypeEffectsUnsupportedMessage } from "./prototypeEffects";
import {
  prototypeStylePolishV2Fields,
  prototypeStylePolishV2UnsupportedMessage,
} from "./prototypeStylePolishV2";
import { PROTOTYPE_STYLE_POLISH_V2_CAPABILITY } from "../observe/android/ctrlProxyProtocol";
import {
  prototypeReducedMotionFields,
  prototypeSharedElementFields,
  prototypeReducedMotionUnsupportedMessage,
  prototypeSharedElementUnsupportedMessage,
} from "./prototypeSharedElement";
import { prototypeTimerFields, prototypeTimersUnsupportedMessage } from "./prototypeTimers";
import {
  prototypeStackTransitionFields,
  prototypeStackTransitionsUnsupportedMessage,
} from "./prototypeStackTransitions";
import {
  PROTOTYPE_TIMERS_CAPABILITY,
  PROTOTYPE_EFFECTS_CAPABILITY,
  PROTOTYPE_REDUCED_MOTION_CAPABILITY,
  PROTOTYPE_SHARED_ELEMENT_CAPABILITY,
  PROTOTYPE_STACK_CAPABILITY,
  PROTOTYPE_STACK_TRANSITIONS_CAPABILITY,
  PROTOTYPE_THEME_MODES_CAPABILITY,
  PROTOTYPE_DATA_MODEL_CAPABILITY,
  PROTOTYPE_FLOW_GRID_CAPABILITY,
  PROTOTYPE_PAGER_OPTIONS_CAPABILITY,
  PROTOTYPE_GESTURES_CAPABILITY,
  PROTOTYPE_SWIPE_ACTIONS_CAPABILITY,
  PROTOTYPE_TEXT_FIELD_ACTIONS_CAPABILITY,
  PROTOTYPE_CAROUSEL_CAPABILITY,
  PROTOTYPE_TEXT_FIELD_LEADING_ICON_CAPABILITY,
  PROTOTYPE_REFRESH_CAPABILITY,
  PROTOTYPE_SEARCH_BAR_CAPABILITY,
  PROTOTYPE_LOADING_STATES_CAPABILITY,
  PROTOTYPE_MOTION_V2_CAPABILITY,
  PROTOTYPE_CHOREOGRAPHY_CAPABILITY,
  PROTOTYPE_CHART_CAPABILITY,
  PROTOTYPE_CHAT_SCROLL_CAPABILITY,
  PROTOTYPE_RICH_TEXT_CAPABILITY,
  PROTOTYPE_LINKIFY_CAPABILITY,
  PROTOTYPE_MENUS_CAPABILITY,
  PROTOTYPE_EMIT_CONTEXT_CAPABILITY,
  PROTOTYPE_CHECKS_CAPABILITY,
  PROTOTYPE_DATA_ACTIONS_CAPABILITY,
  PROTOTYPE_STORAGE_CAPABILITY,
  PROTOTYPE_NETWORK_CAPABILITY,
  PROTOTYPE_NETWORK_DEVICE_CAPABILITY,
  PROTOTYPE_PLATFORM_CAPABILITY,
  PROTOTYPE_ANCHOR_CAPABILITY,
  PROTOTYPE_WINDOW_CHROME_CAPABILITY,
} from "../observe/android/ctrlProxyProtocol";
import { hasPrototypeAnchors } from "./prototypeAnchors";
import {
  PROTOTYPE_PLATFORM_MODULE_GATES,
  prototypePlatformFields,
  prototypePlatformUnsupportedMessage,
} from "./prototypePlatform";
import {
  prototypeDataActionFields,
  prototypeDataActionsUnsupportedMessage,
} from "./prototypeDataActions";
import { prototypeStorageFields, prototypeStorageUnsupportedMessage } from "./prototypeStorage";
import {
  prototypeDeviceRequestFields,
  prototypeNetworkDeviceUnsupportedMessage,
  prototypeNetworkUnsupportedMessage,
  prototypeRequestFields,
} from "./prototypeRequest";
import { prototypeStackFields, prototypeStackUnsupportedMessage } from "./prototypeSpec";
import {
  prototypeThemeModeFields,
  prototypeThemeModesUnsupportedMessage,
} from "./prototypeThemeModes";
import { prototypeDataModelFields, prototypeDataModelUnsupportedMessage } from "./prototypeData";
import { PROTOTYPE_TEXT_FIELD_OPTIONS_CAPABILITY } from "../observe/android/ctrlProxyProtocol";
import {
  prototypeTextFieldActionFields,
  prototypeTextFieldActionsUnsupportedMessage,
  prototypeTextFieldLeadingIconFields,
  prototypeTextFieldLeadingIconUnsupportedMessage,
  prototypeTextFieldOptionFields,
  prototypeTextFieldOptionsUnsupportedMessage,
} from "./prototypeTextFieldOptions";
import { prototypeFlowGridFields, prototypeFlowGridUnsupportedMessage } from "./prototypeFlowGrid";
import {
  prototypePagerOptionFields,
  prototypePagerOptionsUnsupportedMessage,
} from "./prototypePagerOptions";
import { prototypeGestureFields, prototypeGesturesUnsupportedMessage } from "./prototypeGestures";
import {
  prototypeSwipeActionFields,
  prototypeSwipeActionsUnsupportedMessage,
} from "./prototypeSwipeActions";
import { prototypeCarouselFields, prototypeCarouselUnsupportedMessage } from "./prototypeCarousel";
import { prototypeRefreshFields, prototypeRefreshUnsupportedMessage } from "./prototypeRefresh";
import {
  prototypeSearchBarFields,
  prototypeSearchBarUnsupportedMessage,
} from "./prototypeSearchBar";
import {
  prototypeLoadingStatesFields,
  prototypeLoadingStatesUnsupportedMessage,
} from "./prototypeLoadingStates";
import {
  prototypeChoreographyFields,
  prototypeChoreographyUnsupportedMessage,
} from "./prototypeChoreography";
import { prototypeMotionV2Fields, prototypeMotionV2UnsupportedMessage } from "./prototypeMotionV2";
import { prototypeChartFields, prototypeChartUnsupportedMessage } from "./prototypeChart";
import { prototypeRichTextFields, prototypeRichTextUnsupportedMessage } from "./prototypeRichText";
import { prototypeLinkifyFields, prototypeLinkifyUnsupportedMessage } from "./prototypeLinkify";
import {
  prototypeChatScrollFields,
  prototypeChatScrollUnsupportedMessage,
} from "./prototypeChatScroll";
import { prototypeMenuFields, prototypeMenusUnsupportedMessage } from "./prototypeData";
import {
  prototypeEmitContextFields,
  prototypeEmitContextUnsupportedMessage,
} from "./prototypeEmitContext";
import {
  prototypeChecksFields,
  prototypeChecksUnsupportedMessage,
} from "./prototypeChecksCapability";

import { PROTOTYPE_TOOLTIP_CAPABILITY } from "../observe/android/ctrlProxyProtocol";
import { prototypeTooltipFields, prototypeTooltipUnsupportedMessage } from "./prototypeTooltip";

import { PROTOTYPE_DRAWER_CAPABILITY } from "../observe/android/ctrlProxyProtocol";
import { prototypeDrawerFields, prototypeDrawerUnsupportedMessage } from "./prototypeDrawer";

interface PrototypeSpecCapabilityGate {
  readonly capability: string;
  readonly fields: (spec: unknown) => string[];
  readonly unsupportedMessage: (fields: readonly string[], platform: "android" | "ios") => string;
}

/** Spec-introduced features must be checked on both show and the complete patch result. */
export const PROTOTYPE_SPEC_CAPABILITY_GATES: readonly PrototypeSpecCapabilityGate[] = [
  {
    capability: PROTOTYPE_STYLE_POLISH_V2_CAPABILITY,
    fields: prototypeStylePolishV2Fields,
    unsupportedMessage: prototypeStylePolishV2UnsupportedMessage,
  },
  {
    capability: PROTOTYPE_DRAWER_CAPABILITY,
    fields: prototypeDrawerFields,
    unsupportedMessage: prototypeDrawerUnsupportedMessage,
  },
  {
    capability: PROTOTYPE_TOOLTIP_CAPABILITY,
    fields: prototypeTooltipFields,
    unsupportedMessage: prototypeTooltipUnsupportedMessage,
  },
  {
    capability: PROTOTYPE_THEME_MODES_CAPABILITY,
    fields: prototypeThemeModeFields,
    unsupportedMessage: prototypeThemeModesUnsupportedMessage,
  },
  {
    capability: PROTOTYPE_DATA_MODEL_CAPABILITY,
    fields: prototypeDataModelFields,
    unsupportedMessage: prototypeDataModelUnsupportedMessage,
  },
  {
    capability: PROTOTYPE_TEXT_FIELD_OPTIONS_CAPABILITY,
    fields: prototypeTextFieldOptionFields,
    unsupportedMessage: prototypeTextFieldOptionsUnsupportedMessage,
  },
  {
    capability: PROTOTYPE_TEXT_FIELD_ACTIONS_CAPABILITY,
    fields: prototypeTextFieldActionFields,
    unsupportedMessage: prototypeTextFieldActionsUnsupportedMessage,
  },
  {
    capability: PROTOTYPE_TEXT_FIELD_LEADING_ICON_CAPABILITY,
    fields: prototypeTextFieldLeadingIconFields,
    unsupportedMessage: prototypeTextFieldLeadingIconUnsupportedMessage,
  },
  {
    capability: PROTOTYPE_FLOW_GRID_CAPABILITY,
    fields: prototypeFlowGridFields,
    unsupportedMessage: prototypeFlowGridUnsupportedMessage,
  },
  {
    capability: PROTOTYPE_PAGER_OPTIONS_CAPABILITY,
    fields: prototypePagerOptionFields,
    unsupportedMessage: prototypePagerOptionsUnsupportedMessage,
  },
  {
    capability: PROTOTYPE_GESTURES_CAPABILITY,
    fields: prototypeGestureFields,
    unsupportedMessage: prototypeGesturesUnsupportedMessage,
  },
  {
    capability: PROTOTYPE_CAROUSEL_CAPABILITY,
    fields: prototypeCarouselFields,
    unsupportedMessage: prototypeCarouselUnsupportedMessage,
  },
  {
    capability: PROTOTYPE_REFRESH_CAPABILITY,
    fields: prototypeRefreshFields,
    unsupportedMessage: prototypeRefreshUnsupportedMessage,
  },
  {
    capability: PROTOTYPE_SWIPE_ACTIONS_CAPABILITY,
    fields: prototypeSwipeActionFields,
    unsupportedMessage: prototypeSwipeActionsUnsupportedMessage,
  },
  {
    capability: PROTOTYPE_SEARCH_BAR_CAPABILITY,
    fields: prototypeSearchBarFields,
    unsupportedMessage: prototypeSearchBarUnsupportedMessage,
  },
  {
    capability: PROTOTYPE_LOADING_STATES_CAPABILITY,
    fields: prototypeLoadingStatesFields,
    unsupportedMessage: prototypeLoadingStatesUnsupportedMessage,
  },
  {
    capability: PROTOTYPE_WINDOW_MOTION_CAPABILITY,
    fields: prototypeWindowMotionFields,
    unsupportedMessage: (fields) =>
      `The connected device does not advertise prototype_window_motion_v1, required by ${fields.join(", ")}. Nothing was shown. Update the agent or remove these fields.`,
  },
  {
    capability: PROTOTYPE_MOTION_V2_CAPABILITY,
    fields: prototypeMotionV2Fields,
    unsupportedMessage: prototypeMotionV2UnsupportedMessage,
  },
  {
    capability: PROTOTYPE_CHOREOGRAPHY_CAPABILITY,
    fields: prototypeChoreographyFields,
    unsupportedMessage: prototypeChoreographyUnsupportedMessage,
  },
  {
    capability: PROTOTYPE_EFFECTS_CAPABILITY,
    fields: prototypeEffectFields,
    unsupportedMessage: prototypeEffectsUnsupportedMessage,
  },
  {
    capability: PROTOTYPE_CHART_CAPABILITY,
    fields: prototypeChartFields,
    unsupportedMessage: prototypeChartUnsupportedMessage,
  },
  {
    capability: PROTOTYPE_CHAT_SCROLL_CAPABILITY,
    fields: prototypeChatScrollFields,
    unsupportedMessage: prototypeChatScrollUnsupportedMessage,
  },
  {
    capability: PROTOTYPE_RICH_TEXT_CAPABILITY,
    fields: prototypeRichTextFields,
    unsupportedMessage: prototypeRichTextUnsupportedMessage,
  },
  {
    capability: PROTOTYPE_LINKIFY_CAPABILITY,
    fields: prototypeLinkifyFields,
    unsupportedMessage: prototypeLinkifyUnsupportedMessage,
  },
  {
    capability: PROTOTYPE_MENUS_CAPABILITY,
    fields: prototypeMenuFields,
    unsupportedMessage: prototypeMenusUnsupportedMessage,
  },
  {
    capability: PROTOTYPE_STACK_CAPABILITY,
    fields: prototypeStackFields,
    unsupportedMessage: (_fields, platform) => prototypeStackUnsupportedMessage(platform),
  },
  {
    capability: PROTOTYPE_REDUCED_MOTION_CAPABILITY,
    fields: prototypeReducedMotionFields,
    unsupportedMessage: prototypeReducedMotionUnsupportedMessage,
  },
  {
    capability: PROTOTYPE_SHARED_ELEMENT_CAPABILITY,
    fields: prototypeSharedElementFields,
    unsupportedMessage: prototypeSharedElementUnsupportedMessage,
  },
  {
    capability: PROTOTYPE_STACK_TRANSITIONS_CAPABILITY,
    fields: prototypeStackTransitionFields,
    unsupportedMessage: prototypeStackTransitionsUnsupportedMessage,
  },
  {
    capability: PROTOTYPE_EMIT_CONTEXT_CAPABILITY,
    fields: prototypeEmitContextFields,
    unsupportedMessage: prototypeEmitContextUnsupportedMessage,
  },
  {
    capability: PROTOTYPE_CHECKS_CAPABILITY,
    fields: prototypeChecksFields,
    unsupportedMessage: prototypeChecksUnsupportedMessage,
  },
  {
    capability: PROTOTYPE_DATA_ACTIONS_CAPABILITY,
    fields: prototypeDataActionFields,
    unsupportedMessage: prototypeDataActionsUnsupportedMessage,
  },
  {
    capability: PROTOTYPE_TIMERS_CAPABILITY,
    fields: prototypeTimerFields,
    unsupportedMessage: prototypeTimersUnsupportedMessage,
  },
  {
    capability: PROTOTYPE_STORAGE_CAPABILITY,
    fields: prototypeStorageFields,
    unsupportedMessage: prototypeStorageUnsupportedMessage,
  },
  {
    capability: PROTOTYPE_NETWORK_CAPABILITY,
    fields: prototypeRequestFields,
    unsupportedMessage: prototypeNetworkUnsupportedMessage,
  },
  {
    capability: PROTOTYPE_NETWORK_DEVICE_CAPABILITY,
    fields: prototypeDeviceRequestFields,
    unsupportedMessage: prototypeNetworkDeviceUnsupportedMessage,
  },
  {
    capability: PROTOTYPE_PLATFORM_CAPABILITY,
    fields: prototypePlatformFields,
    unsupportedMessage: prototypePlatformUnsupportedMessage,
  },
  ...PROTOTYPE_PLATFORM_MODULE_GATES,
];

export function prototypeRequiredCapabilities(spec: unknown): {
  capability: string;
  fields: string[];
  unsupportedMessage: PrototypeSpecCapabilityGate["unsupportedMessage"];
}[] {
  return PROTOTYPE_SPEC_CAPABILITY_GATES.flatMap((gate) => {
    const fields = gate.fields(spec);
    return fields.length === 0
      ? []
      : [{ capability: gate.capability, fields, unsupportedMessage: gate.unsupportedMessage }];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Capabilities the show preflight checks outside the gate table (#14536): any node anchor needs
 * prototype_anchor_v1, and an explicitly chromeless fullscreen window needs
 * prototype_window_chrome_v1 (the only chrome request the preflight refuses without it).
 */
function preflightCapabilities(spec: unknown): string[] {
  if (!isRecord(spec)) {
    return [];
  }
  const window = isRecord(spec.window) ? spec.window : {};
  const fullscreen = isRecord(window.placement) && window.placement.type === "fullscreen";
  return [
    ...(hasPrototypeAnchors(spec) ? [PROTOTYPE_ANCHOR_CAPABILITY] : []),
    ...(fullscreen && window.chrome === "none" ? [PROTOTYPE_WINDOW_CHROME_CAPABILITY] : []),
  ];
}

/**
 * Capability names required by the gate table alone: the set the native strict validators
 * (Kotlin and Swift) compute and the shared corpus records.
 */
export function prototypeGateCapabilities(spec: unknown): string[] {
  return [...new Set(prototypeRequiredCapabilities(spec).map((gate) => gate.capability))].sort();
}

/** Capability names required by a spec, for the native-code resource's renderer contract. */
export function requiredPrototypeCapabilities(spec: unknown): string[] {
  return [...new Set([...prototypeGateCapabilities(spec), ...preflightCapabilities(spec)])].sort();
}
