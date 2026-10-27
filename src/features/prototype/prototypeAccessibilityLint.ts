/**
 * Static accessibility lint for prototype specs (#14126). It reads the spec only: no device, and it
 * never refuses a show. Findings are advisory and name the spec path they apply to.
 */

import { prototypeRequiredPluralCategories } from "./prototypeStrings";
import { expandPrototypeComponents } from "./prototypeComponents";
import { prototypeNodeChildren, prototypeSpecNodeRoots } from "./prototypeNodeChildren";
import {
  compositeColor,
  contrastRatio,
  prototypeRolePalette,
  resolvePrototypeColor,
  type PrototypeColorMode,
  type Rgba,
} from "./prototypeContrast";
import { record } from "./prototypeTemplate";

export const PROTOTYPE_ACCESSIBILITY_RULES = [
  "missing-translation",
  "unknown-translation-key",
  "empty-heading",
  "unlabeled-control",
  "unlabeled-image",
  "unlabeled-text-field",
  "low-contrast",
  "small-touch-target",
  "transition-without-visible-when",
] as const;
export type PrototypeAccessibilityRule = (typeof PROTOTYPE_ACCESSIBILITY_RULES)[number];

export interface PrototypeAccessibilityFinding {
  rule: PrototypeAccessibilityRule;
  /** The node's path in the spec, as validation errors spell it. */
  path: string;
  detail: string;
  /** low-contrast: the colour mode the ratio was computed in. */
  mode?: PrototypeColorMode;
  /** low-contrast: the ratio found; small-touch-target: the smallest authored side in dp. */
  value?: number;
  /** The WCAG minimum the value falls short of. */
  minimum?: number;
}

export const MAX_PROTOTYPE_ACCESSIBILITY_FINDINGS = 50;

/** Material and Apple minimum touch target: 48dp on Android, 44pt on iOS. */
const MIN_TOUCH_TARGET_DP = 48;
const NORMAL_TEXT_CONTRAST = 4.5;
const LARGE_TEXT_CONTRAST = 3;

const TAP_FIELDS = ["onTap", "onLongPress", "onDoubleTap"] as const;
/** Fields that give a node an accessible name. */
const NAME_FIELDS = [
  "semantics.label",
  "contentDescription",
  "label",
  "text",
  "spans",
  "headline",
  "title",
] as const;
/** Controls whose only name is an optional `label` or `contentDescription`. */
const LABEL_OPTIONAL_CONTROLS = new Set([
  "iconButton",
  "fab",
  "switch",
  "checkbox",
  "slider",
  "select",
]);
/** Nodes a user acts on even without onTap. */
const CONTROL_TYPES = new Set([
  ...LABEL_OPTIONAL_CONTROLS,
  "button",
  "chip",
  "textField",
  "searchBar",
  "segmentedButton",
  "radioGroup",
]);
/** Components that paint their own surface, so the background under their content is unknown. */
const SURFACE_TYPES = new Set([
  "card",
  "dialog",
  "bottomSheet",
  "tooltip",
  "drawer",
  "snackbar",
  "topAppBar",
  "bottomNav",
  "tabBar",
  "button",
  "fab",
  "chip",
]);

type Backgrounds = Partial<Record<PrototypeColorMode, Rgba>>;
interface Visit {
  node: Record<string, unknown>;
  path: string;
  backgrounds: Backgrounds;
}
interface LintContext {
  modes: PrototypeColorMode[];
  palettes: Record<PrototypeColorMode, Map<string, Rgba>>;
}

/** Every finding for a spec, in tree order, and how many there were before the output cap. */
export function lintPrototypeAccessibility(spec: unknown): {
  findings: PrototypeAccessibilityFinding[];
  total: number;
} {
  const context = lintContext(spec);
  const findings: PrototypeAccessibilityFinding[] = translationFindings(spec);
  const pending: Visit[] = prototypeSpecNodeRoots(spec)
    .flatMap(({ node, path }) => {
      const object = record(node);
      return object ? [{ node: object, path, backgrounds: rootBackgrounds(context) }] : [];
    })
    .reverse();
  while (pending.length > 0) {
    const visit = pending.pop()!;
    findings.push(...nodeFindings(visit, context));
    const backgrounds = childBackgrounds(visit, context);
    const children = prototypeNodeChildren(visit.node);
    for (let index = children.length - 1; index >= 0; index--) {
      const child = record(children[index]!.value);
      if (child) {
        pending.push({ node: child, path: `${visit.path}${children[index]!.suffix}`, backgrounds });
      }
    }
  }
  return {
    findings: findings.slice(0, MAX_PROTOTYPE_ACCESSIBILITY_FINDINGS),
    total: findings.length,
  };
}

function lintContext(spec: unknown): LintContext {
  const mode = record(record(spec)?.theme)?.mode;
  const modes: PrototypeColorMode[] =
    mode === "light" || mode === "dark" ? [mode] : ["light", "dark"];
  return {
    modes,
    palettes: {
      light: prototypeRolePalette(spec, "light"),
      dark: prototypeRolePalette(spec, "dark"),
    },
  };
}

function rootBackgrounds(context: LintContext): Backgrounds {
  return Object.fromEntries(
    context.modes.flatMap((mode) => {
      const surface = context.palettes[mode].get("surface");
      return surface ? [[mode, surface]] : [];
    }),
  );
}

function nodeFindings(visit: Visit, context: LintContext): PrototypeAccessibilityFinding[] {
  return [
    ...labelFindings(visit.node, visit.path),
    ...(record(visit.node.semantics)?.heading === true && !hasName(visit.node)
      ? [
          {
            rule: "empty-heading" as const,
            path: `${visit.path}.semantics.heading`,
            detail: "Heading has no text or accessible label.",
          },
        ]
      : []),
    ...touchTargetFindings(visit.node, visit.path),
    ...contrastFindings(visit, context),
    ...transitionFindings(visit.node, visit.path),
  ];
}

/**
 * A node `transition` only animates the `visibleWhen` enter/exit, so one without `visibleWhen`
 * never runs (#15112). A stack's `transition` animates screen navigation instead.
 */
function transitionFindings(
  node: Record<string, unknown>,
  path: string,
): PrototypeAccessibilityFinding[] {
  if (node.transition === undefined || node.type === "stack" || node.visibleWhen !== undefined) {
    return [];
  }
  return [
    {
      rule: "transition-without-visible-when",
      path,
      detail: `This ${String(node.type)} has a transition but no visibleWhen, so nothing ever enters or exits and the transition has no effect. Add visibleWhen, or remove the transition.`,
    },
  ];
}

function isTappable(node: Record<string, unknown>): boolean {
  return TAP_FIELDS.some((field) => node[field] !== undefined);
}

function hasOwnName(node: Record<string, unknown>): boolean {
  return NAME_FIELDS.some((field) => {
    const value = field === "semantics.label" ? record(node.semantics)?.label : node[field];
    return (
      (typeof value === "string" && value.trim() !== "") ||
      (Array.isArray(value) && value.some((span) => String(record(span)?.text ?? "").trim() !== ""))
    );
  });
}

/** A tappable container is named by any text, label or description inside it (merged semantics). */
function hasName(node: Record<string, unknown>): boolean {
  const pending = [node];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (hasOwnName(current)) {
      return true;
    }
    pending.push(
      ...prototypeNodeChildren(current).flatMap(({ value }) => {
        const child = record(value);
        return child ? [child] : [];
      }),
    );
  }
  return false;
}

function labelFindings(
  node: Record<string, unknown>,
  path: string,
): PrototypeAccessibilityFinding[] {
  const type = node.type;
  if (type === "textField" || type === "searchBar") {
    return textFieldFindings(node, path);
  }
  if (LABEL_OPTIONAL_CONTROLS.has(String(type)) || isTappable(node)) {
    return hasName(node)
      ? []
      : [
          {
            rule: "unlabeled-control",
            path,
            detail: `This ${String(type)} can be activated but has no label, text or contentDescription, so a screen reader announces it without a name. Add contentDescription (or label).`,
          },
        ];
  }
  if ((type === "image" || type === "icon") && node.testTag !== undefined && !hasOwnName(node)) {
    return [
      {
        rule: "unlabeled-image",
        path,
        detail: `This ${type} has a testTag, so it is exposed to accessibility, but has no contentDescription. Add one, or drop the testTag to leave it decorative (an untagged, non-tappable ${type} without a description is hidden from screen readers).`,
      },
    ];
  }
  return [];
}

function textFieldFindings(
  node: Record<string, unknown>,
  path: string,
): PrototypeAccessibilityFinding[] {
  const named = [
    record(node.semantics)?.label,
    node.label,
    node.placeholder,
    node.contentDescription,
  ].some((value) => typeof value === "string" && value.trim() !== "");
  return named
    ? []
    : [
        {
          rule: "unlabeled-text-field",
          path,
          detail: `This ${String(node.type)} has no label, placeholder or contentDescription, so a screen reader cannot say what to type. Add a label.`,
        },
      ];
}

function authoredDp(style: Record<string, unknown> | undefined, field: string): number | undefined {
  const value = style?.[field];
  const dp = typeof value === "number" ? value : record(value)?.dp;
  return typeof dp === "number" ? dp : undefined;
}

function touchTargetFindings(
  node: Record<string, unknown>,
  path: string,
): PrototypeAccessibilityFinding[] {
  if (!isTappable(node) && !CONTROL_TYPES.has(String(node.type))) {
    return [];
  }
  const style = record(node.style);
  const sides = ["width", "height", "maxWidth", "maxHeight"].flatMap((field) => {
    const dp = authoredDp(style, field);
    return dp === undefined ? [] : [dp];
  });
  const smallest = Math.min(...sides);
  if (sides.length === 0 || smallest >= MIN_TOUCH_TARGET_DP) {
    return [];
  }
  return [
    {
      rule: "small-touch-target",
      path,
      value: smallest,
      minimum: MIN_TOUCH_TARGET_DP,
      detail: `This ${String(node.type)} is authored ${smallest}dp on one side, below the ${MIN_TOUCH_TARGET_DP}dp touch target (44pt on iOS). Make it at least ${MIN_TOUCH_TARGET_DP}dp, or pad it.`,
    },
  ];
}

/** What a node paints under its children, per mode; undefined when the host cannot know it. */
function childBackgrounds(visit: Visit, context: LintContext): Backgrounds {
  const style = record(visit.node.style);
  if (style?.gradient !== undefined || style?.alpha !== undefined) {
    return {};
  }
  if (style?.background === undefined) {
    return SURFACE_TYPES.has(String(visit.node.type)) ? {} : visit.backgrounds;
  }
  return Object.fromEntries(
    context.modes.flatMap((mode) => {
      const painted = resolvePrototypeColor(style.background, mode, context.palettes[mode]);
      const under = visit.backgrounds[mode];
      if (!painted || (painted.a < 1 && !under)) {
        return [];
      }
      return [[mode, painted.a < 1 && under ? compositeColor(painted, under) : painted]];
    }),
  );
}

function isLargeText(style: Record<string, unknown> | undefined): boolean {
  const size = typeof style?.textSize === "number" ? style.textSize : 0;
  const bold = typeof style?.fontWeight === "number" && style.fontWeight >= 700;
  const role = typeof style?.textStyle === "string" ? style.textStyle : "";
  return size >= 24 || (bold && size >= 18.66) || /^(display|headline)/.test(role);
}

/** Text with an authored colour, against the nearest background the host can resolve. */
function contrastFindings(visit: Visit, context: LintContext): PrototypeAccessibilityFinding[] {
  const style = record(visit.node.style);
  if (visit.node.type !== "text" || style?.color === undefined || style.alpha !== undefined) {
    return [];
  }
  const minimum = isLargeText(style) ? LARGE_TEXT_CONTRAST : NORMAL_TEXT_CONTRAST;
  return context.modes.flatMap((mode) => {
    const background = childBackgrounds(visit, context)[mode];
    const color = resolvePrototypeColor(style.color, mode, context.palettes[mode]);
    if (!background || !color) {
      return [];
    }
    const ratio = contrastRatio(
      color.a < 1 ? compositeColor(color, background) : color,
      background,
    );
    return ratio >= minimum
      ? []
      : [
          {
            rule: "low-contrast" as const,
            path: visit.path,
            mode,
            value: Math.round(ratio * 100) / 100,
            minimum,
            detail: `Text colour against its background is ${ratio.toFixed(2)}:1 in ${mode} mode; WCAG AA needs ${minimum}:1 for ${minimum === LARGE_TEXT_CONTRAST ? "large" : "normal"} text.`,
          },
        ];
  });
}

/**
 * The tool-output fields for a spec's lint: both absent when there is nothing to report. A spec
 * with `use` nodes is linted after component expansion, so findings inside a component are
 * reported, at the authored path they came from (for example `root.children[2] (use card) →
 * components.card.root`).
 */
export function prototypeAccessibilityOutput(spec: unknown): {
  accessibilityFindings?: PrototypeAccessibilityFinding[];
  accessibilityFindingsTotal?: number;
} {
  const expansion = expandPrototypeComponents(spec);
  const linted = expansion.success ? expansion.spec : spec;
  const locate = expansion.success ? expansion.locate : (path: string) => path;
  const { findings, total } = lintPrototypeAccessibility(linted);
  if (findings.length === 0) {
    return {};
  }
  return {
    accessibilityFindings: findings.map((finding) => ({ ...finding, path: locate(finding.path) })),
    ...(total > findings.length ? { accessibilityFindingsTotal: total } : {}),
  };
}

function translationFindings(spec: unknown): PrototypeAccessibilityFinding[] {
  const tables = record(record(spec)?.strings);
  const defaults = record(tables?.default);
  if (!tables || !defaults) {
    return [];
  }
  return Object.entries(tables).flatMap(([tag, raw]) =>
    tag === "default" ? [] : localeFindings(defaults, record(raw) ?? {}, tag),
  );
}

function localeFindings(
  defaults: Record<string, unknown>,
  table: Record<string, unknown>,
  tag: string,
): PrototypeAccessibilityFinding[] {
  const findings: PrototypeAccessibilityFinding[] = [];
  const required = prototypeRequiredPluralCategories(tag);
  for (const [key, entry] of Object.entries(defaults)) {
    const detail = translationDetail(entry, table[key], required);
    if (detail) {
      findings.push({ rule: "missing-translation", path: `strings.${tag}.${key}`, detail });
    }
  }
  for (const key of Object.keys(table)) {
    if (!Object.hasOwn(defaults, key)) {
      findings.push({
        rule: "unknown-translation-key",
        path: `strings.${tag}.${key}`,
        detail: "Key is absent from default and cannot be referenced.",
      });
    }
  }
  return findings;
}

function translationDetail(
  entry: unknown,
  translated: unknown,
  required: readonly string[],
): string | undefined {
  if (translated === undefined) {
    return "Missing translation; locale chain falls back.";
  }
  if (typeof entry !== typeof translated) {
    return "Translation shape differs from default (string versus plural).";
  }
  const plural = record(translated);
  const missingForms = plural ? required.filter((form) => !Object.hasOwn(plural, form)) : [];
  return missingForms.length ? `Missing plural forms: ${missingForms.join(", ")}.` : undefined;
}
