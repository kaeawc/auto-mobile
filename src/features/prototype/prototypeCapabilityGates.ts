import {
  PROTOTYPE_THEME_MODES_CAPABILITY,
  PROTOTYPE_DATA_MODEL_CAPABILITY,
  PROTOTYPE_FLOW_GRID_CAPABILITY,
} from "../observe/android/ctrlProxyProtocol";
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
