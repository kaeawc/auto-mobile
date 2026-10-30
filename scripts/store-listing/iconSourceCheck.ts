import { parseStringPromise } from "xml2js";
import type { Finding } from "./storeListing";

/** The Android adaptive-icon canvas; both layers are authored on it and scaled to every size. */
export const ICON_VIEW_BOX = "0 0 108 108";

interface SvgRoot {
  svg?: { $?: { viewBox?: string } };
}

/** Checks one icon layer parses as SVG and is authored on the shared 108 canvas. */
export async function validateIconSvg(path: string, svg: string | undefined): Promise<Finding[]> {
  if (svg === undefined) {
    return [{ path, message: "icon source layer is missing" }];
  }
  let root: SvgRoot;
  try {
    root = (await parseStringPromise(svg)) as SvgRoot;
  } catch (error) {
    return [
      {
        path,
        message: `is not well-formed XML: ${error instanceof Error ? error.message : String(error)}`,
      },
    ];
  }
  if (root.svg === undefined) {
    return [{ path, message: "root element must be <svg>" }];
  }
  const viewBox = root.svg.$?.viewBox?.trim().replace(/[\s,]+/g, " ");
  if (viewBox !== ICON_VIEW_BOX) {
    return [{ path, message: `viewBox must be "${ICON_VIEW_BOX}" (found ${viewBox ?? "none"})` }];
  }
  return [];
}
