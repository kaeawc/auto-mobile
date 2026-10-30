import type { ElementBounds } from "../../models/ElementBounds";
import type { ImageBackend } from "../../utils/image/backend/ImageBackend";
import { cropSnapshot } from "../observe/screenshot/snapshotCrop";
import type { SnapshotGeometry } from "../observe/screenshot/snapshotCrop";
import { assertBaselineName, type VisualBaselineStore } from "./VisualBaselineStore";
import { profileDifferences, type VisualDeviceProfile } from "./VisualDeviceProfile";
import { diffPngs, type PixelRect } from "./VisualDiff";

/** A region in platform-native screen units (Android pixels, iOS points). */
export interface VisualRegion {
  elementId?: string;
  rect?: ElementBounds;
}

export interface CompareScreenshotRequest {
  baseline: string;
  mode: "compare" | "record" | "recordIfMissing";
  target?: VisualRegion;
  mask?: readonly VisualRegion[];
  ignoreSystemBars?: boolean;
  threshold?: { pixelRatio?: number; perPixelDelta?: number };
}

/** One fresh capture of the screen the comparison runs against. */
export interface VisualScreen {
  png: Buffer;
  geometry: SnapshotGeometry;
  /** Native bounds of one exposed element; throws when it is missing or ambiguous. */
  resolveElement(elementId: string): ElementBounds;
  /** Native rectangles the system bars occupy. */
  systemBars: readonly ElementBounds[];
}

export interface CompareScreenshotDependencies<S extends VisualScreen = VisualScreen> {
  capture: () => Promise<S>;
  profile: (screen: S) => Promise<VisualDeviceProfile>;
  store: VisualBaselineStore;
  backend: ImageBackend;
  writeFile: (filePath: string, data: Buffer) => Promise<void>;
  now: () => string;
}

interface CompareBase {
  baseline: string;
  mode: CompareScreenshotRequest["mode"];
  profile: VisualDeviceProfile;
}

export type CompareScreenshotOutcome =
  | (CompareBase & { status: "recorded"; match: true; baselinePath: string })
  | (CompareBase & {
      status: "compared";
      match: boolean;
      diffRatio: number;
      diffPixels: number;
      comparedPixels: number;
      baselinePath: string;
      diffImagePath?: string;
    })
  | (CompareBase & {
      status: "failed";
      match: false;
      errorCode: "baseline_missing" | "baseline_profile_mismatch" | "size_mismatch";
      error: string;
      baselinePath?: string;
      otherProfiles?: VisualDeviceProfile[];
    });

function screenBounds(geometry: SnapshotGeometry): ElementBounds {
  return { left: 0, top: 0, right: geometry.screenSize.width, bottom: geometry.screenSize.height };
}

function regionBounds(region: VisualRegion, screen: VisualScreen): ElementBounds {
  if (region.rect) {
    return region.rect;
  }
  if (region.elementId) {
    return screen.resolveElement(region.elementId);
  }
  return screenBounds(screen.geometry);
}

/** A native rectangle in the cropped image's pixels. */
function toCropPixels(
  bounds: ElementBounds,
  origin: ElementBounds,
  scale: { x: number; y: number },
): PixelRect {
  return {
    left: (bounds.left - origin.left) * scale.x,
    top: (bounds.top - origin.top) * scale.y,
    right: (bounds.right - origin.left) * scale.x,
    bottom: (bounds.bottom - origin.top) * scale.y,
  };
}

/**
 * Record or compare a named screenshot baseline (#14083). Baselines are per device profile; a
 * baseline that exists only for another profile is refused, never compared.
 */
export class CompareScreenshot<S extends VisualScreen = VisualScreen> {
  constructor(private readonly deps: CompareScreenshotDependencies<S>) {}

  async execute(request: CompareScreenshotRequest): Promise<CompareScreenshotOutcome> {
    assertBaselineName(request.baseline);
    const screen = await this.deps.capture();
    const crop = await cropSnapshot(
      screen.png,
      request.target ? regionBounds(request.target, screen) : screenBounds(screen.geometry),
      screen.geometry,
      { backend: this.deps.backend, label: "compareScreenshot" },
    );
    const profile = await this.deps.profile(screen);
    const base: CompareBase = { baseline: request.baseline, mode: request.mode, profile };
    const existing =
      request.mode === "record" ? null : await this.deps.store.read(request.baseline, profile);
    if (!existing && request.mode !== "compare") {
      const written = await this.deps.store.write(
        request.baseline,
        profile,
        crop.png,
        this.deps.now(),
      );
      return { ...base, status: "recorded", match: true, baselinePath: written.path };
    }
    if (!existing) {
      return this.missing(base, request.baseline, profile);
    }
    const ignore = [
      ...(request.mask ?? []).map((region) => regionBounds(region, screen)),
      ...(request.ignoreSystemBars === false ? [] : screen.systemBars),
    ].map((bounds) => toCropPixels(bounds, crop.clippedBounds, crop.pixelsPerNativeUnit));
    return this.compare(base, existing.png, existing.path, crop.png, {
      ignore,
      ...request.threshold,
    });
  }

  private async missing(
    base: CompareBase,
    name: string,
    profile: VisualDeviceProfile,
  ): Promise<CompareScreenshotOutcome> {
    const otherProfiles = await this.deps.store.otherProfiles(name, profile);
    if (otherProfiles.length === 0) {
      return {
        ...base,
        status: "failed",
        match: false,
        errorCode: "baseline_missing",
        error: `No baseline "${name}" is recorded. Record one with mode "record" or "recordIfMissing".`,
      };
    }
    const differences = otherProfiles.map((other) => profileDifferences(other, profile).join(", "));
    return {
      ...base,
      status: "failed",
      match: false,
      errorCode: "baseline_profile_mismatch",
      error:
        `Baseline "${name}" was recorded on a different device profile, so it is not compared ` +
        `(${differences.join("; ")}). Record it on this profile with mode "recordIfMissing".`,
      otherProfiles,
    };
  }

  private async compare(
    base: CompareBase,
    baselinePng: Buffer,
    baselinePath: string,
    current: Buffer,
    options: Parameters<typeof diffPngs>[2],
  ): Promise<CompareScreenshotOutcome> {
    const result = diffPngs(baselinePng, current, options);
    if (result === "size_mismatch") {
      return {
        ...base,
        status: "failed",
        match: false,
        errorCode: "size_mismatch",
        error: "The captured region and the baseline differ in size; re-record the baseline.",
        baselinePath,
      };
    }
    let diffImagePath: string | undefined;
    if (result.diffPng) {
      diffImagePath = this.deps.store.diffPath(base.baseline, base.profile);
      await this.deps.writeFile(diffImagePath, result.diffPng);
    }
    return {
      ...base,
      status: "compared",
      match: result.match,
      diffRatio: result.diffRatio,
      diffPixels: result.diffPixels,
      comparedPixels: result.comparedPixels,
      baselinePath,
      ...(diffImagePath ? { diffImagePath } : {}),
    };
  }
}
