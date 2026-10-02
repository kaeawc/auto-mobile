import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod/v4";
import type { ObserveResult } from "../../../models/ObserveResult";
import type { ElementBounds } from "../../../models/ElementBounds";
import { ActionableError } from "../../../models/ActionableError";
import { tapOnSelectorSchema } from "../../../server/elementSelectorSchemas";
import { hasUsableHierarchy } from "../ObserveScreen";
import { ElementResolver } from "../../utility/ElementResolver";
import { SearchableHierarchy } from "../../utility/SearchableNode";
import type { ImageBackend } from "../../../utils/image/backend/ImageBackend";
import { resolveImageBackend } from "../../../utils/image/backend/resolveImageBackend";
import { defaultIdGenerator, type IdGenerator } from "../../../utils/IdGenerator";
import { ensureSecureTempDirSync, TEMP_SUBDIRS } from "../../../utils/tempDir";
import { defaultScreenshotFileWriter, type ScreenshotFileWriter } from "./ScreenshotFileWriter";
import { cropSnapshot, type SnapshotCropResult } from "./snapshotCrop";

export const observeCropSchema = z.union([
  z.object({ element: tapOnSelectorSchema }).strict(),
  z
    .object({
      rect: z
        .object({
          x: z.number().finite(),
          y: z.number().finite(),
          width: z.number().finite().positive(),
          height: z.number().finite().positive(),
        })
        .strict(),
    })
    .strict(),
]);

export type ObserveCrop = z.infer<typeof observeCropSchema>;
export interface ObserveCropResult extends Omit<SnapshotCropResult, "png"> {
  cropPath: string;
  unit: "pixels" | "points";
}

export interface ObserveCropDependencies {
  readFile?: (filePath: string) => Promise<Buffer>;
  writer?: ScreenshotFileWriter;
  imageBackend?: ImageBackend;
  outputDirectory?: () => string;
  ids?: IdGenerator;
}

function requestedBounds(crop: ObserveCrop, observation: ObserveResult): ElementBounds {
  if ("rect" in crop) {
    const { x, y, width, height } = crop.rect;
    return { left: x, top: y, right: x + width, bottom: y + height };
  }
  if ("accessibilityLink" in crop.element) {
    throw new ActionableError(
      "observe crop requires an exposed element with bounds; semantic accessibility links have no independent bounds. Select the owning element instead.",
    );
  }
  const snapshot = {
    id: observation.observationId,
    nodes: new SearchableHierarchy().project(observation.viewHierarchy!),
  };
  const resolver = new ElementResolver();
  // Ordered text variants retain tapOn semantics; a matching ambiguous variant fails.
  const selectors =
    "textAny" in crop.element ? crop.element.textAny.map((text) => ({ text })) : [crop.element];
  for (const selector of selectors) {
    const resolution = resolver.resolve(snapshot, selector, {
      action: "inspect",
      requireBounds: true,
    });
    if (resolution.error) {
      throw new ActionableError(`observe crop: ${resolution.error}`);
    }
    if (resolution.candidates.length > 1) {
      throw new ActionableError(
        `observe crop element is ambiguous (${resolution.candidates.length} matches). Use a unique selector.`,
      );
    }
    if (resolution.candidates.length === 1 && resolution.chosen?.bounds) {
      return resolution.chosen.bounds;
    }
  }
  throw new ActionableError(
    "observe crop element was not found with bounds. Observe again and use an exposed element selector.",
  );
}

function requireCropCapture(observation: ObserveResult) {
  if (
    observation.screenshotSettled !== true ||
    !observation.screenshotPath ||
    observation.screenshotSource === "cached"
  ) {
    throw new ActionableError(
      "observe crop requires a fresh validated settled screenshot. Retry observe with screenshot: 'settled'.",
    );
  }
  if (!observation.viewHierarchy || !hasUsableHierarchy(observation.viewHierarchy)) {
    throw new ActionableError(
      "observe crop requires screen geometry from the captured hierarchy. Retry observe when the hierarchy service is available.",
    );
  }
  return { screenshotPath: observation.screenshotPath, hierarchy: observation.viewHierarchy };
}

/** Crop the already validated settled raster; never acquire another hierarchy or screenshot. */
export async function createObserveCrop(
  crop: ObserveCrop,
  observation: ObserveResult,
  platform: "android" | "ios",
  dependencies: ObserveCropDependencies = {},
  selectorObservation: ObserveResult = observation,
): Promise<ObserveCropResult> {
  const { screenshotPath, hierarchy } = requireCropCapture(observation);
  const bounds = requestedBounds(crop, selectorObservation);
  const source = await (dependencies.readFile ?? fs.readFile)(screenshotPath);
  const { png, ...metadata } = await cropSnapshot(
    source,
    bounds,
    {
      platform,
      screenSize: { width: observation.screenSize.width, height: observation.screenSize.height },
      rotation: observation.rotation ?? hierarchy.rotation,
      nativeScale: hierarchy.nativeScale,
      rasterOrientation: observation.screenshotOrientation,
    },
    dependencies.imageBackend ?? resolveImageBackend(),
    "observe crop",
  );
  const cropPath = path.join(
    dependencies.outputDirectory?.() ?? ensureSecureTempDirSync(TEMP_SUBDIRS.SCREENSHOTS),
    `crop-${(dependencies.ids ?? defaultIdGenerator).next()}.png`,
  );
  await (dependencies.writer ?? defaultScreenshotFileWriter).write(cropPath, png);
  return { ...metadata, cropPath, unit: platform === "ios" ? "points" : "pixels" };
}
