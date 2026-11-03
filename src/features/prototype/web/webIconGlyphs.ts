import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Parser } from "xml2js";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import { el, type WebElement } from "./webNodes";

/** The contract's `iconVariant` values; anything else draws `filled`, as on Android. */
export type PrototypeIconVariant = "filled" | "outlined" | "rounded" | "sharp" | "twoTone";

/**
 * Where the web renderer finds an icon's glyph: the SVG shapes of a 24 x 24 viewBox, or
 * undefined when the name has no glyph in that variant or in `filled`.
 */
export interface PrototypeIconGlyphSource {
  glyph(name: string, variant: PrototypeIconVariant): readonly WebElement[] | undefined;
}

const VARIANTS: ReadonlySet<string> = new Set([
  "filled",
  "outlined",
  "rounded",
  "sharp",
  "twoTone",
]);

export function prototypeIconVariant(value: unknown): PrototypeIconVariant {
  return typeof value === "string" && VARIANTS.has(value)
    ? (value as PrototypeIconVariant)
    : "filled";
}

/** An icon's 24 px box; the spec's own style still wins. */
export const ICON_BOX: Readonly<Record<string, string>> = {
  display: "inline-flex",
  width: "24px",
  height: "24px",
  "flex-shrink": "0",
};

/** No glyph: a tinted ring around the name's initial, titled with the full name. */
export const ICON_PLACEHOLDER: Readonly<Record<string, string>> = {
  ...ICON_BOX,
  "align-items": "center",
  "justify-content": "center",
  border: "2px solid currentColor",
  "border-radius": "6px",
  "font-size": "11px",
  "font-weight": "700",
  "line-height": "1",
};

/** The first letter of an icon's name, so a placeholder reads as that icon; none without a name. */
export function iconInitial(name: unknown): string {
  const letter = typeof name === "string" ? /[a-z0-9]/i.exec(name)?.[0] : undefined;
  return letter ? letter.toUpperCase() : "";
}

/**
 * A glyph filling its icon box, tinted by `currentColor` as Compose tints by LocalContentColor
 * unless the style sets one. The HTML parser restores `viewBox`'s case on an inline SVG.
 */
export function glyphSvg(shapes: readonly WebElement[]): WebElement {
  const attrs = { viewbox: "0 0 24 24", width: "100%", height: "100%", fill: "currentColor" };
  return el("svg", { attrs: { ...attrs, "aria-hidden": "true" } }, shapes);
}

/** Contract variant to the Material Icons package directory for that style. */
const VARIANT_DIRECTORY: Readonly<Record<PrototypeIconVariant, string>> = {
  filled: "filled",
  outlined: "outlined",
  rounded: "round",
  sharp: "sharp",
  twoTone: "two-tone",
};

/** Snake-case contract names, so a name can never leave the package's style directory. */
const ICON_NAME = /^[a-z0-9]+(_[a-z0-9]+)*$/;

/**
 * Shapes and attributes a glyph may carry. A glyph using anything else (one two-tone glyph uses
 * `<defs>`/`<use>` ids that would collide when a page draws it twice) is treated as absent, so the
 * `filled` glyph stands in, as Android falls back to `filled`.
 */
const SHAPES: ReadonlySet<string> = new Set(["path", "circle", "ellipse", "g"]);
const SHAPE_ATTRIBUTES: ReadonlySet<string> = new Set([
  "d",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "opacity",
  "fill-opacity",
  "fill-rule",
]);

interface SvgNode {
  readonly "#name": string;
  readonly $?: Readonly<Record<string, string>>;
  readonly $$?: readonly SvgNode[];
}

const svgParser = new Parser({
  explicitChildren: true,
  preserveChildrenOrder: true,
  explicitRoot: false,
  async: false,
});

function parseSvg(svg: string): SvgNode | undefined {
  let parsed: SvgNode | undefined;
  // xml2js calls back synchronously with `async: false`, so the render pass stays synchronous.
  svgParser.parseString(svg, (error: unknown, value: SvgNode) => {
    if (error) {
      throw error;
    }
    parsed = value;
  });
  return parsed;
}

function shape(node: SvgNode): WebElement | undefined {
  const attrs = node.$ ?? {};
  if (
    !SHAPES.has(node["#name"]) ||
    Object.keys(attrs).some((name) => !SHAPE_ATTRIBUTES.has(name))
  ) {
    return undefined;
  }
  const children = (node.$$ ?? []).map(shape);
  if (children.some((child) => child === undefined)) {
    return undefined;
  }
  return el(node["#name"], { attrs: { ...attrs } }, children as WebElement[]);
}

/** A 24 x 24 Material Icons SVG as renderable shapes; undefined when it uses anything else. */
export function glyphShapes(svg: string): readonly WebElement[] | undefined {
  const root = parseSvg(svg);
  if (root?.["#name"] !== "svg" || root.$?.viewBox !== "0 0 24 24") {
    return undefined;
  }
  const shapes = (root.$$ ?? []).map(shape);
  return shapes.length > 0 && shapes.every((entry) => entry !== undefined)
    ? (shapes as WebElement[])
    : undefined;
}

/** Reads one style's SVG for a name; undefined when that style has no such file. */
export type MaterialIconFileReader = (directory: string, name: string) => string | undefined;

/**
 * The Material Icons glyphs Android draws (Compose `material-icons-extended`), read from the
 * Apache-2.0 `@material-design-icons/svg` package one file at a time and cached, so a page only
 * ever carries the glyphs it draws.
 */
export class MaterialIconGlyphSource implements PrototypeIconGlyphSource {
  private readonly cache = new Map<string, readonly WebElement[] | undefined>();

  constructor(private readonly read: MaterialIconFileReader = readMaterialIconFile) {}

  glyph(name: string, variant: PrototypeIconVariant): readonly WebElement[] | undefined {
    if (!ICON_NAME.test(name)) {
      return undefined;
    }
    return (
      this.styled(name, variant) ?? (variant === "filled" ? undefined : this.styled(name, "filled"))
    );
  }

  private styled(name: string, variant: PrototypeIconVariant): readonly WebElement[] | undefined {
    const key = `${variant}/${name}`;
    if (!this.cache.has(key)) {
      const svg = this.read(VARIANT_DIRECTORY[variant], name);
      this.cache.set(key, svg === undefined ? undefined : glyphShapes(svg));
    }
    return this.cache.get(key);
  }
}

let packageRoot: string | undefined;

/**
 * `import.meta.resolve` keeps the specifier in the bundle, where the release tooling reads it as a
 * runtime dependency of the published package.
 */
function materialIconPackageRoot(): string {
  packageRoot ??= dirname(
    fileURLToPath(import.meta.resolve("@material-design-icons/svg/package.json")),
  );
  return packageRoot;
}

function readMaterialIconFile(directory: string, name: string): string | undefined {
  try {
    return readFileSync(join(materialIconPackageRoot(), directory, `${name}.svg`), "utf8");
  } catch (error) {
    // A name the package lacks (a deprecated Compose-only icon) draws the placeholder instead.
    logger.debug(`Material icon ${directory}/${name} not found: ${errorMessage(error)}`);
    return undefined;
  }
}

let shared: MaterialIconGlyphSource | undefined;

/** The process-wide Material Icons source, so its cache is shared across renders. */
export function materialIconGlyphs(): MaterialIconGlyphSource {
  shared ??= new MaterialIconGlyphSource();
  return shared;
}
