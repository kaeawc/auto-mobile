/**
 * Backend seam for image processing.
 *
 * `ImageTransformer` records the caller's resize/crop/encode requests into a
 * declarative `ImagePipeline`, then hands the source buffer + pipeline to an
 * `ImageBackend` for execution. This decouples the fluent transform API from
 * the concrete decoder/encoder (sharp on macOS/Linux; jimp on Windows until
 * the cwebp follow-up lands), so later issues can swap backends without
 * touching call sites.
 */

/** Basic image metadata surfaced by every backend. */
export interface ImageMetadata {
  width: number;
  height: number;
  format: string;
  size: number;
}

/**
 * A single declarative transform step. Backends interpret these rather than
 * receiving pre-bound closures, so the same pipeline can run on any backend.
 */
export type ImageOperation =
  | {
      type: "resize";
      width: number;
      height?: number;
      maintainAspectRatio: boolean;
      /**
       * Resampling kernel. `"nearest"` maps every destination pixel to a single
       * source pixel (no interpolation) — required by consumers that must not
       * introduce averaged colors (pHash 8×8 downscale, comparator resize).
       * Omitted keeps the backend default (jimp: bilinear), matching historical
       * behavior for general-purpose resizes. (Only the non-default kernel needs
       * a name; a second mode can be added when a consumer needs it.)
       */
      mode?: "nearest";
    }
  | { type: "crop"; x: number; y: number; width: number; height: number };

/**
 * The requested output encoding. `null` (on the pipeline) means "re-encode in
 * the decoded input format", matching the transformer's historical fallback.
 * `options` carries backend-agnostic encoder intent (e.g. quality/lossless
 * booleans). Concrete backends translate that intent to codec-specific flags.
 */
export interface ImageEncoding {
  mime: "image/png" | "image/webp";
  options?: Record<string, unknown>;
}

/** Declarative description of a transform: ordered operations + output encoding. */
export interface ImagePipeline {
  operations: ImageOperation[];
  encoding: ImageEncoding | null;
}

/** Decoded raw pixels (RGBA, row-major) for pixel-level consumers. */
export interface RawImage {
  width: number;
  height: number;
  /** RGBA bytes, length === width * height * 4. */
  data: Buffer;
}

/**
 * Executes declarative image pipelines and exposes metadata / raw pixels.
 * Implemented by production backends (`SharpBackend`, `JimpBackend`) and
 * `FakeImageBackend` for tests.
 */
export interface ImageBackend {
  /** Decode `source`, apply `pipeline.operations`, encode per `pipeline.encoding`. */
  execute(source: Buffer, pipeline: ImagePipeline): Promise<Buffer>;
  /** Decode `source` and report dimensions/format/size without re-encoding. */
  metadata(source: Buffer): Promise<ImageMetadata>;
  /** Decode `source` to raw RGBA pixels. */
  rawPixels(source: Buffer): Promise<RawImage>;
}
