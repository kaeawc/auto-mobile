import type {
  ImageBackend,
  ImageMetadata,
  ImagePipeline,
  RawImage,
} from "../../src/utils/image/backend/ImageBackend";

/** Real decoders reject an empty buffer; the fake does too so error paths match. */
function assertNonEmpty(source: Buffer): void {
  if (source.length === 0) {
    throw new Error("Input buffer is empty");
  }
}

/**
 * Fake `ImageBackend` for fast, deterministic tests.
 *
 * Returns canned buffers / metadata / raw pixels and records every call so
 * tests can assert what pipeline the transformer handed to the backend without
 * decoding real images. Mirrors the configure/track/error-inject shape of the
 * other repo fakes (see FakeImageUtils).
 */
export class FakeImageBackend implements ImageBackend {
  // Canned results.
  private executeResult: Buffer = Buffer.from("fake-execute-result");
  private metadataResult: ImageMetadata = {
    width: 1080,
    height: 2400,
    format: "png",
    size: 1024000,
  };
  private rawPixelsResult: RawImage = {
    width: 2,
    height: 2,
    // 2x2 RGBA: red, green, blue, white.
    data: Buffer.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]),
  };

  // Error injection.
  private shouldThrowOnExecute = false;
  private shouldThrowOnMetadata = false;
  private shouldThrowOnRawPixels = false;

  // Call tracking.
  public readonly executeCalls: Array<{ source: Buffer; pipeline: ImagePipeline }> = [];
  public readonly metadataCalls: Buffer[] = [];
  public readonly rawPixelsCalls: Buffer[] = [];

  setExecuteResult(buffer: Buffer): void {
    this.executeResult = buffer;
  }

  setMetadataResult(metadata: ImageMetadata): void {
    this.metadataResult = metadata;
  }

  setRawPixelsResult(raw: RawImage): void {
    // RawImage is RGBA by contract; a mismatched buffer would let tests pass on pixels no
    // real backend can return.
    if (raw.data.length !== raw.width * raw.height * 4) {
      throw new Error(
        `RawImage data length ${raw.data.length} != width*height*4 (${raw.width * raw.height * 4})`,
      );
    }
    this.rawPixelsResult = {
      width: raw.width,
      height: raw.height,
      data: Buffer.from(raw.data),
    };
  }

  setShouldThrowOnExecute(shouldThrow: boolean): void {
    this.shouldThrowOnExecute = shouldThrow;
  }

  setShouldThrowOnMetadata(shouldThrow: boolean): void {
    this.shouldThrowOnMetadata = shouldThrow;
  }

  setShouldThrowOnRawPixels(shouldThrow: boolean): void {
    this.shouldThrowOnRawPixels = shouldThrow;
  }

  /** The pipeline handed to the most recent `execute` call, if any. */
  get lastPipeline(): ImagePipeline | undefined {
    return this.executeCalls[this.executeCalls.length - 1]?.pipeline;
  }

  async execute(source: Buffer, pipeline: ImagePipeline): Promise<Buffer> {
    this.executeCalls.push({ source, pipeline });
    assertNonEmpty(source);
    if (this.shouldThrowOnExecute) {
      throw new Error("Simulated error in execute");
    }
    // Return a defensive copy, mirroring rawPixels(): a consumer that mutates the
    // returned buffer must not corrupt the canned result for the next call.
    return Buffer.from(this.executeResult);
  }

  async metadata(source: Buffer): Promise<ImageMetadata> {
    this.metadataCalls.push(source);
    assertNonEmpty(source);
    if (this.shouldThrowOnMetadata) {
      throw new Error("Simulated error in metadata");
    }
    // Fresh object per call, as real backends build one from each decode.
    return { ...this.metadataResult };
  }

  async rawPixels(source: Buffer): Promise<RawImage> {
    this.rawPixelsCalls.push(source);
    assertNonEmpty(source);
    if (this.shouldThrowOnRawPixels) {
      throw new Error("Simulated error in rawPixels");
    }
    return {
      width: this.rawPixelsResult.width,
      height: this.rawPixelsResult.height,
      data: Buffer.from(this.rawPixelsResult.data),
    };
  }
}
