import { ImageUtils } from "../../src/utils/interfaces/ImageUtils";

/**
 * Fake implementation of ImageUtils for testing
 * Allows configuring responses for each method and asserting method calls
 */
export class FakeImageUtils implements ImageUtils {
  // Configuration state
  private originalBufferResult: Buffer = Buffer.from("original buffer data");
  private resizeResult: Buffer = Buffer.from("resized buffer data");
  private cropResult: Buffer = Buffer.from("cropped buffer data");
  private pngResult: Buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG magic bytes
  private webpResult: Buffer = Buffer.from("RIFF");
  private metadataResult = {
    width: 1080,
    height: 2400,
    format: "png",
    size: 1024000,
  };
  private batchProcessResult: Buffer[] = [];

  // Error injection
  private shouldThrowOnGetOriginalBuffer: boolean = false;
  private shouldThrowOnResize: boolean = false;
  private shouldThrowOnCrop: boolean = false;
  private shouldThrowOnToPng: boolean = false;
  private shouldThrowOnToWebp: boolean = false;
  private shouldThrowOnGetMetadata: boolean = false;
  private shouldThrowOnBatchProcess: boolean = false;

  // Call tracking
  private methodCalls: Map<string, Array<Record<string, unknown>>> = new Map();

  /**
   * Configure original buffer result
   */
  setOriginalBufferResult(buffer: Buffer): void {
    this.originalBufferResult = buffer;
  }

  /**
   * Configure resize result
   */
  setResizeResult(buffer: Buffer): void {
    this.resizeResult = buffer;
  }

  /**
   * Configure crop result
   */
  setCropResult(buffer: Buffer): void {
    this.cropResult = buffer;
  }

  /**
   * Configure PNG result
   */
  setPngResult(buffer: Buffer): void {
    this.pngResult = buffer;
  }

  /**
   * Configure WebP result
   */
  setWebpResult(buffer: Buffer): void {
    this.webpResult = buffer;
  }

  /**
   * Configure metadata result
   */
  setMetadataResult(metadata: {
    width: number;
    height: number;
    format: string;
    size: number;
  }): void {
    this.metadataResult = metadata;
  }

  /**
   * Configure batch process result
   */
  setBatchProcessResult(buffers: Buffer[]): void {
    this.batchProcessResult = buffers;
  }

  /**
   * Enable error throwing for getOriginalBuffer
   */
  setShouldThrowOnGetOriginalBuffer(shouldThrow: boolean): void {
    this.shouldThrowOnGetOriginalBuffer = shouldThrow;
  }

  /**
   * Enable error throwing for resize
   */
  setShouldThrowOnResize(shouldThrow: boolean): void {
    this.shouldThrowOnResize = shouldThrow;
  }

  /**
   * Enable error throwing for crop
   */
  setShouldThrowOnCrop(shouldThrow: boolean): void {
    this.shouldThrowOnCrop = shouldThrow;
  }

  /**
   * Enable error throwing for toPng
   */
  setShouldThrowOnToPng(shouldThrow: boolean): void {
    this.shouldThrowOnToPng = shouldThrow;
  }

  /**
   * Enable error throwing for toWebp
   */
  setShouldThrowOnToWebp(shouldThrow: boolean): void {
    this.shouldThrowOnToWebp = shouldThrow;
  }

  /**
   * Enable error throwing for getMetadata
   */
  setShouldThrowOnGetMetadata(shouldThrow: boolean): void {
    this.shouldThrowOnGetMetadata = shouldThrow;
  }

  /**
   * Enable error throwing for batchProcess
   */
  setShouldThrowOnBatchProcess(shouldThrow: boolean): void {
    this.shouldThrowOnBatchProcess = shouldThrow;
  }

  /**
   * Get list of method calls for a specific method (for test assertions)
   */
  getMethodCalls(methodName: string): Array<Record<string, unknown>> {
    return this.methodCalls.get(methodName) || [];
  }

  /**
   * Check if a method was called
   */
  wasMethodCalled(methodName: string): boolean {
    const calls = this.methodCalls.get(methodName);
    return calls ? calls.length > 0 : false;
  }

  /**
   * Get count of method calls
   */
  getMethodCallCount(methodName: string): number {
    const calls = this.methodCalls.get(methodName);
    return calls ? calls.length : 0;
  }

  /**
   * Clear all call history
   */
  clearCallHistory(): void {
    this.methodCalls.clear();
  }

  /**
   * Record a method call with parameters
   */
  private recordCall(methodName: string, params: Record<string, unknown>): void {
    if (!this.methodCalls.has(methodName)) {
      this.methodCalls.set(methodName, []);
    }
    this.methodCalls.get(methodName)!.push(params);
  }

  // Implementation of ImageUtils interface

  getOriginalBuffer(buffer: Buffer): Buffer {
    this.recordCall("getOriginalBuffer", { bufferLength: buffer.length });
    if (this.shouldThrowOnGetOriginalBuffer) {
      throw new Error("Simulated error in getOriginalBuffer");
    }
    return this.originalBufferResult;
  }

  async resize(
    buffer: Buffer,
    width: number,
    height?: number,
    maintainAspectRatio = true,
  ): Promise<Buffer> {
    this.recordCall("resize", { bufferLength: buffer.length, width, height, maintainAspectRatio });
    if (this.shouldThrowOnResize) {
      throw new Error("Simulated error in resize");
    }
    return this.resizeResult;
  }

  async crop(buffer: Buffer, width: number, height: number, x = 0, y = 0): Promise<Buffer> {
    this.recordCall("crop", { bufferLength: buffer.length, width, height, x, y });
    if (this.shouldThrowOnCrop) {
      throw new Error("Simulated error in crop");
    }
    return this.cropResult;
  }

  async toPng(buffer: Buffer): Promise<Buffer> {
    this.recordCall("toPng", { bufferLength: buffer.length });
    if (this.shouldThrowOnToPng) {
      throw new Error("Simulated error in toPng");
    }
    return this.pngResult;
  }

  async toWebp(
    buffer: Buffer,
    options?: {
      quality?: number;
      lossless?: boolean;
      nearLossless?: boolean;
    },
  ): Promise<Buffer> {
    this.recordCall("toWebp", {
      bufferLength: buffer.length,
      quality: options?.quality,
      lossless: options?.lossless,
      nearLossless: options?.nearLossless,
    });
    if (this.shouldThrowOnToWebp) {
      throw new Error("Simulated error in toWebp");
    }
    return this.webpResult;
  }

  async getMetadata(buffer: Buffer): Promise<{
    width: number;
    height: number;
    format: string;
    size: number;
  }> {
    this.recordCall("getMetadata", { bufferLength: buffer.length });
    if (this.shouldThrowOnGetMetadata) {
      throw new Error("Simulated error in getMetadata");
    }
    return this.metadataResult;
  }

  clearCache(): void {
    this.recordCall("clearCache", {});
  }

  setCacheSize(megabytes: number): void {
    this.recordCall("setCacheSize", { megabytes });
  }

  async batchProcess(
    buffers: Buffer[],
    transform: (buffer: Buffer) => Promise<Buffer>,
  ): Promise<Buffer[]> {
    this.recordCall("batchProcess", { bufferCount: buffers.length });
    if (this.shouldThrowOnBatchProcess) {
      throw new Error("Simulated error in batchProcess");
    }
    if (this.batchProcessResult.length > 0) {
      return this.batchProcessResult;
    }
    // Default: apply transform to each buffer
    return Promise.all(buffers.map((buffer) => transform(buffer)));
  }
}
