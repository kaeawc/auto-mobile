import {
  PROTOTYPE_STACK_CAPABILITY,
  PROTOTYPE_THEME_MODES_CAPABILITY,
  PROTOTYPE_DATA_MODEL_CAPABILITY,
} from "../observe/android/ctrlProxyProtocol";
import { prototypeHasStack, prototypeStackUnsupportedMessage } from "./prototypeSpec";
import {
  prototypeThemeModeFields,
  prototypeThemeModesUnsupportedMessage,
} from "./prototypeThemeModes";
import { prototypeDataModelFields, prototypeDataModelUnsupportedMessage } from "./prototypeData";

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
    capability: PROTOTYPE_STACK_CAPABILITY,
    fields: prototypeStackFields,
    unsupportedMessage: (_fields, platform) => prototypeStackUnsupportedMessage(platform),
  },
];

/** Finds stack use in the full authored spec, including reusable component definitions. */
export function prototypeStackFields(spec: unknown): string[] {
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
    return [];
  }
  const value = spec as Record<string, unknown>;
  const fields = prototypeHasStack(spec) ? ["root"] : [];
  const components = value.components;
  if (typeof components === "object" && components !== null && !Array.isArray(components)) {
    for (const [name, component] of Object.entries(components)) {
      if (
        typeof component === "object" &&
        component !== null &&
        !Array.isArray(component) &&
        prototypeHasStack({ root: (component as Record<string, unknown>).root })
      ) {
        fields.push(`components.${name}.root`);
      }
    }
  }
  return fields;
}

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
