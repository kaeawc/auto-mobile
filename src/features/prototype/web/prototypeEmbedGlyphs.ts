import contract from "../../../../schemas/prototype-spec-contract.json";
import { iconNames } from "../prototypePresentationSchemas";
import type { ShownSpecJson } from "../PrototypeShownSpecs";
import { prototypeIconVariant, type PrototypeIconGlyphSource } from "./webIconGlyphs";
import { toHtml } from "./webNodes";

/** Glyphs an embed envelope ships: markup keyed `<variant>/<name>`, plus the keys with none. */
export interface PrototypeEmbedGlyphs {
  /** Each value is the glyph's allow-listed shapes as SVG markup for a 24 x 24 viewBox. */
  readonly glyphs: Readonly<Record<string, string>>;
  /** Keys with no glyph in their variant or in `filled`, as a still reports `iconMissing`. */
  readonly iconMissing: readonly string[];
}

interface Rule {
  readonly kind: string;
  readonly name?: string;
  readonly item?: Rule;
  readonly fields?: Readonly<Record<string, { readonly rule: Rule } | undefined>>;
  readonly variants?: Readonly<Record<string, Rule>>;
  readonly options?: readonly Rule[];
}

const definitions: Readonly<Record<string, Rule>> = contract.definitions;

/** Where the walk records names; a slot's variant comes from its object's `iconVariant` field. */
interface Collected {
  readonly keys: Set<string>;
  readonly variants: Set<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function walkEntries(entries: readonly unknown[], rule: Rule | undefined, found: Collected): void {
  if (rule) {
    entries.forEach((entry) => walk(entry, rule, found));
  }
}

type Walker = (value: unknown, rule: Rule, found: Collected) => void;

const walkRecord: Walker = (value, rule, found) => {
  if (isRecord(value)) {
    walkEntries(Object.values(value), rule.item, found);
  }
};

/** Container kinds of the contract; leaf kinds hold no iconName slot. */
const WALKERS: Readonly<Record<string, Walker>> = {
  ref: (value, rule, found) => walkRef(value, rule.name!, found),
  array: (value, rule, found) => {
    if (Array.isArray(value)) {
      walkEntries(value, rule.item, found);
    }
  },
  map: walkRecord,
  record: walkRecord,
  screenMap: walkRecord,
  object: (value, rule, found) => walkObject(value, rule, found),
  tagged: (value, rule, found) => {
    const variant = isRecord(value) ? rule.variants?.[String(value.type)] : undefined;
    if (variant) {
      walk(value, variant, found);
    }
  },
  // Only iconName-valid strings are kept, so walking every option cannot add a foreign name.
  choice: (value, rule, found) => rule.options?.forEach((option) => walk(value, option, found)),
};

function walk(value: unknown, rule: Rule, found: Collected): void {
  if (value !== undefined && value !== null) {
    WALKERS[rule.kind]?.(value, rule, found);
  }
}

function walkRef(value: unknown, name: string, found: Collected): void {
  if (name === "iconName") {
    if (typeof value === "string" && iconNames.has(value)) {
      found.keys.add(`filled/${value}`);
    }
    return;
  }
  const rule = definitions[name];
  if (rule) {
    walk(value, rule, found);
  }
}

const isIconRef = (rule: Rule | undefined, name: string) =>
  rule?.kind === "ref" && rule.name === name;

function walkObject(value: unknown, rule: Rule, found: Collected): void {
  if (!isRecord(value)) {
    return;
  }
  const fields = Object.entries(rule.fields ?? {});
  const variantField = fields.find(([, field]) => isIconRef(field?.rule, "iconVariant"))?.[0];
  const variant = variantField ? prototypeIconVariant(value[variantField]) : "filled";
  if (variantField) {
    found.variants.add(variant);
  }
  for (const [key, field] of fields) {
    const child = value[key];
    if (isIconRef(field?.rule, "iconName") && typeof child === "string") {
      if (iconNames.has(child)) {
        found.keys.add(`${variant}/${child}`);
      }
    } else if (field) {
      walk(child, field.rule, found);
    }
  }
}

/** Every iconName-valid string anywhere in a state map or data block. */
function reachableNames(value: unknown, names: Set<string>): void {
  if (typeof value === "string") {
    if (iconNames.has(value)) {
      names.add(value);
    }
  } else if (Array.isArray(value)) {
    value.forEach((entry) => reachableNames(entry, names));
  } else if (isRecord(value)) {
    Object.values(value).forEach((entry) => reachableNames(entry, names));
  }
}

/**
 * The `<variant>/<name>` keys a spec can draw, sorted: every contract `iconName` slot in its
 * own variant (an `icon` node's `variant`, else `filled`), plus each iconName-valid string in
 * `state` or `data` in `filled` and in every variant an icon node uses, since a state change can
 * hand that name to any icon.
 */
export function prototypeGlyphKeys(spec: ShownSpecJson): string[] {
  const found: Collected = { keys: new Set(), variants: new Set(["filled"]) };
  walk(spec, definitions.spec!, found);
  const names = new Set<string>();
  reachableNames(spec.state, names);
  reachableNames(spec.data, names);
  for (const name of names) {
    for (const variant of found.variants) {
      found.keys.add(`${variant}/${name}`);
    }
  }
  return [...found.keys].sort();
}

/** The glyph map for a spec's embed envelope: exactly the glyphs it can name. */
export function prototypeEmbedGlyphs(
  spec: ShownSpecJson,
  source: PrototypeIconGlyphSource,
): PrototypeEmbedGlyphs {
  const glyphs: Record<string, string> = {};
  const iconMissing: string[] = [];
  for (const key of prototypeGlyphKeys(spec)) {
    const [variant, name] = key.split("/") as [string, string];
    const shapes = source.glyph(name, prototypeIconVariant(variant));
    if (shapes) {
      glyphs[key] = shapes.map((shape) => toHtml(shape)).join("");
    } else {
      iconMissing.push(key);
    }
  }
  return { glyphs, iconMissing };
}
