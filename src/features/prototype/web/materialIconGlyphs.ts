import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Parser } from "xml2js";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import type { PrototypeIconGlyphSource, PrototypeIconVariant } from "./webIconGlyphs";
import { el, type WebElement } from "./webNodes";

// Server-only: reads glyph files from disk. The page builder injects it into the still renderer,
// which stays free of Node builtins so it can bundle for the browser (#16451).

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
