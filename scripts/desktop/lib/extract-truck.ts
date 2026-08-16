// Extracts the AutoMobile truck from docs/img/logo.svg into two SVG fragments used by
// generate-app-icons.sh:
//   truck-color.frag  the truck in its original colours (red outline, white fill, dark tires),
//                     with the logo's full-canvas white rectangle stripped so it composites
//                     cleanly over the crayon background.
//   truck-mono.frag   the outline + tires as one solid black silhouette for the tintable
//                     menu-bar mask.
import { readFileSync, writeFileSync } from "node:fs";
import { parseStringPromise } from "xml2js";

const logoPath = process.env.LOGO_SVG;
const outDir = process.env.OUT_DIR;
if (!logoPath || !outDir) {
  throw new Error("LOGO_SVG and OUT_DIR must be set");
}

// Parse the SVG with the shared XML parser rather than a regex, so a semantics-preserving
// re-export (reordered attributes, single quotes, self-closing tags) still regenerates cleanly.
const doc = await parseStringPromise(readFileSync(logoPath, "utf8"), {
  explicitArray: false,
  mergeAttrs: false,
});

// Collect every <path>'s (fill -> d) regardless of nesting depth.
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

// The white fill path is a full-canvas rectangle followed by the truck contours (cab/bed outer
// edge, inner detail lines, wheel rings). Dropping the leading rectangle and keeping just the
// FIRST truck contour — the outer perimeter — gives a solid white body silhouette when filled
// non-zero (the later contours are the inner double-lines, which we don't want as holes).
const subpaths = whiteFillFull.split(/(?=M)/);
subpaths.shift(); // drop the full-canvas rectangle
const bodyFill = subpaths[0]; // the truck's outer contour

// The tires are two rings (each an outer + inner contour). Filling just the outer contour of
// each non-zero gives a solid white disc to sit behind the dark ring, so the tires read as
// black-outlined with a white fill rather than showing the red background through the middle.
const tireContours = darkTires.split(/(?=M)/);
const tireFill = (tireContours[0] ?? "") + (tireContours[2] ?? "");

const pathEl = (d: string, fill: string, rule = "evenodd"): string =>
  `<path d="${d}" fill="${fill}" fill-rule="${rule}"/>`;

// Full-colour truck in draw order: solid white body, red outline, white tire fill, dark tire
// rings, then the hand-drawn shading.
const colorFrag =
  pathEl(bodyFill, "#fbfbfb", "nonzero") +
  pathEl(redOutline, "#df3028") +
  pathEl(tireFill, "#ffffff", "nonzero") +
  pathEl(darkTires, "#282827") +
  pathEl(shadeLight, "#f09e98") +
  pathEl(shadeMid, "#df7c71");

// Solid black silhouette (outline + tires) for the tintable menu-bar mask.
const monoFrag = pathEl(redOutline, "#000000") + pathEl(darkTires, "#000000");

writeFileSync(`${outDir}/truck-color.frag`, colorFrag);
writeFileSync(`${outDir}/truck-mono.frag`, monoFrag);
