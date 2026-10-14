import {
  PROTOTYPE_THEME_MODES_CAPABILITY,
  PROTOTYPE_DATA_MODEL_CAPABILITY,
  PROTOTYPE_MENUS_CAPABILITY,
} from "../observe/android/ctrlProxyProtocol";
import {
  prototypeThemeModeFields,
  prototypeThemeModesUnsupportedMessage,
} from "./prototypeThemeModes";
import {
  prototypeDataModelFields,
  prototypeDataModelUnsupportedMessage,
  prototypeMenuFields,
  prototypeMenusUnsupportedMessage,
} from "./prototypeData";

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
    capability: PROTOTYPE_MENUS_CAPABILITY,
    fields: prototypeMenuFields,
    unsupportedMessage: prototypeMenusUnsupportedMessage,
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
