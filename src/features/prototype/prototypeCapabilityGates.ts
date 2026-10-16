import {
  PROTOTYPE_STACK_CAPABILITY,
  PROTOTYPE_THEME_MODES_CAPABILITY,
  PROTOTYPE_DATA_MODEL_CAPABILITY,
  PROTOTYPE_FLOW_GRID_CAPABILITY,
  PROTOTYPE_PAGER_OPTIONS_CAPABILITY,
  PROTOTYPE_GESTURES_CAPABILITY,
  PROTOTYPE_CAROUSEL_CAPABILITY,
  PROTOTYPE_REFRESH_CAPABILITY,
  PROTOTYPE_SEARCH_BAR_CAPABILITY,
  PROTOTYPE_RICH_TEXT_CAPABILITY,
  PROTOTYPE_MENUS_CAPABILITY,
  PROTOTYPE_EMIT_CONTEXT_CAPABILITY,
  PROTOTYPE_CHECKS_CAPABILITY,
  PROTOTYPE_DATA_ACTIONS_CAPABILITY,
} from "../observe/android/ctrlProxyProtocol";
import {
  prototypeDataActionFields,
  prototypeDataActionsUnsupportedMessage,
} from "./prototypeDataActions";
import { prototypeStackFields, prototypeStackUnsupportedMessage } from "./prototypeSpec";
import {
  prototypeThemeModeFields,
  prototypeThemeModesUnsupportedMessage,
} from "./prototypeThemeModes";
import { prototypeDataModelFields, prototypeDataModelUnsupportedMessage } from "./prototypeData";
import { PROTOTYPE_TEXT_FIELD_OPTIONS_CAPABILITY } from "../observe/android/ctrlProxyProtocol";
import {
  prototypeTextFieldOptionFields,
  prototypeTextFieldOptionsUnsupportedMessage,
} from "./prototypeTextFieldOptions";
import { prototypeFlowGridFields, prototypeFlowGridUnsupportedMessage } from "./prototypeFlowGrid";
import {
  prototypePagerOptionFields,
  prototypePagerOptionsUnsupportedMessage,
} from "./prototypePagerOptions";
import { prototypeGestureFields, prototypeGesturesUnsupportedMessage } from "./prototypeGestures";
import { prototypeCarouselFields, prototypeCarouselUnsupportedMessage } from "./prototypeCarousel";
import { prototypeRefreshFields, prototypeRefreshUnsupportedMessage } from "./prototypeRefresh";
import {
  prototypeSearchBarFields,
  prototypeSearchBarUnsupportedMessage,
} from "./prototypeSearchBar";
import { prototypeRichTextFields, prototypeRichTextUnsupportedMessage } from "./prototypeRichText";
import { prototypeMenuFields, prototypeMenusUnsupportedMessage } from "./prototypeData";
import {
  prototypeEmitContextFields,
  prototypeEmitContextUnsupportedMessage,
} from "./prototypeEmitContext";
import {
  prototypeChecksFields,
  prototypeChecksUnsupportedMessage,
} from "./prototypeChecksCapability";

interface PrototypeSpecCapabilityGate {
  readonly capability: string;
  readonly fields: (spec: unknown) => string[];
  readonly unsupportedMessage: (fields: readonly string[], platform: "android" | "ios") => string;
}

/** Spec-introduced features must be checked on both show and the complete patch result. */
export const PROTOTYPE_SPEC_CAPABILITY_GATES: readonly PrototypeSpecCapabilityGate[] = [
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
    capability: PROTOTYPE_SEARCH_BAR_CAPABILITY,
    fields: prototypeSearchBarFields,
    unsupportedMessage: prototypeSearchBarUnsupportedMessage,
  },
  {
    capability: PROTOTYPE_RICH_TEXT_CAPABILITY,
    fields: prototypeRichTextFields,
    unsupportedMessage: prototypeRichTextUnsupportedMessage,
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
