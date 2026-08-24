// Extracts the AutoMobile truck from docs/img/logo.svg into two SVG fragments used by
// generate-app-icons.sh:
//   truck-color.frag  the truck in its original colours (red outline, white fill, dark tires),
//                     with the logo's full-canvas white rectangle stripped so it composites
//                     cleanly over the crayon background.
//   truck-mono.frag   the outline + tires as one solid black silhouette for the tintable
//                     menu-bar mask.
import { readFileSync, writeFileSync } from "node:fs";
import { parseStringPromise } from "xml2js";

export interface TruckFragments {
  colorFrag: string;
  monoFrag: string;
}

/** Splits a path's `d` into its subpaths, honouring both absolute (M) and relative (m) moves. */
const splitSubpaths = (d: string): string[] =>
  d
    .split(/(?=[Mm])/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

/**
 * Returns the subpath contour at [index] from a path's `d`. A non-first contour that begins with a
 * relative move (lowercase `m`) is meaningless once lifted out on its own — its coordinates are
 * relative to the previous contour's end — so we fail loudly rather than silently emitting a
 * mis-placed shape (only the *first* moveto of a `d` is treated as absolute by SVG).
 */
const contourAt = (d: string, index: number, label: string): string => {
  const subpaths = splitSubpaths(d);
  const contour = subpaths[index];
  if (!contour) {
    throw new Error(`logo.svg: expected a ${label} contour at subpath index ${index}`);
  }
  if (index > 0 && contour.startsWith("m")) {
    throw new Error(
      `logo.svg: the ${label} contour uses a relative move (m); re-export the logo with ` +
        "absolute coordinates or teach extract-truck.ts to normalise path data.",
    );
  }
  return contour;
};

const pathEl = (d: string, fill: string, rule = "evenodd"): string =>
  `<path d="${d}" fill="${fill}" fill-rule="${rule}"/>`;

/** Collects every `<path>`'s (fill -> d) from a parsed SVG document, at any nesting depth. */
const collectPathsByFill = (doc: unknown): Map<string, string> => {
  const byFill = new Map<string, string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== "object") {
      return;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === "$") {
        const attrs = value as Record<string, string>;
        if (attrs.d && attrs.fill) {
          byFill.set(attrs.fill.toLowerCase(), attrs.d);
        }
      } else {
        visit(value);
      }
    }
  };
  visit(doc);
  return byFill;
};

/**
 * Builds the colour and monochrome truck fragments from the logo SVG text. Parsing the XML with
 * xml2js (not a regex) tolerates reordered attributes and quoting; the per-path contour selection
 * tolerates relative moves by failing loudly rather than guessing.
 */
export async function extractTruckFragments(svgText: string): Promise<TruckFragments> {
  const doc = await parseStringPromise(svgText, { explicitArray: false, mergeAttrs: false });
  const byFill = collectPathsByFill(doc);

  const need = (fill: string): string => {
    const d = byFill.get(fill);
    if (!d) {
      throw new Error(`logo.svg is missing the expected path fill ${fill}`);
    }
    return d;
  };

  // Colour roles in logo.svg.
  const whiteFillFull = need("#fbfbfb"); // white, drawn as full canvas minus the truck
  const redOutline = need("#df3028");
  const darkTires = need("#282827");
  const shadeLight = need("#f09e98");
  const shadeMid = need("#df7c71");

  // path0 is the full-canvas rectangle (subpath 0) followed by the truck contours; subpath 1 is the
  // outer perimeter, which fills to a solid white body silhouette (non-zero).
  const bodyFill = contourAt(whiteFillFull, 1, "truck body");

  // Each tire is an outer + inner ring; the outer contours (subpaths 0 and 2) filled white sit
  // behind the dark rings so the tires read as black-outlined with a white fill.
  const tireFill = contourAt(darkTires, 0, "first tire") + contourAt(darkTires, 2, "second tire");

  // Full-colour truck in draw order: solid white body, red outline, white tire fill, dark tire
  // rings, then the hand-drawn shading.
  const colorFrag =
    pathEl(bodyFill, "#fbfbfb", "nonzero") +
    pathEl(redOutline, "#df3028") +
    pathEl(tireFill, "#ffffff", "nonzero") +
    pathEl(darkTires, "#282827") +
    pathEl(shadeLight, "#f09e98") +
    pathEl(shadeMid, "#df7c71");

  // Solid black silhouette (filled body + filled tires) for the tintable menu-bar mask. Filling
  // the body and tires — rather than just the thin outline strokes — keeps the truck legible once
  // the OS downsizes it to a ~16px status slot and the disconnected tint dims it.
  const monoFrag = pathEl(bodyFill, "#000000", "nonzero") + pathEl(tireFill, "#000000", "nonzero");

  return { colorFrag, monoFrag };
}

if (import.meta.main) {
  const logoPath = process.env.LOGO_SVG;
  const outDir = process.env.OUT_DIR;
  if (!logoPath || !outDir) {
    throw new Error("LOGO_SVG and OUT_DIR must be set");
  }
  const { colorFrag, monoFrag } = await extractTruckFragments(readFileSync(logoPath, "utf8"));
  writeFileSync(`${outDir}/truck-color.frag`, colorFrag);
  writeFileSync(`${outDir}/truck-mono.frag`, monoFrag);
}
