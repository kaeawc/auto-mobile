import { ScreenshotUtils } from "../../src/utils/interfaces/ScreenshotUtils";

/**
 * Fake implementation of ScreenshotUtils for testing
 * Allows configuring responses for each method and asserting method calls
 */
export class FakeScreenshotUtils implements ScreenshotUtils {
  // Configuration state
  private cachedScreenshots: Map<string, { buffer: Buffer; hash: string }> = new Map();
  private imageDimensions: { width: number; height: number } = { width: 1080, height: 2400 };
  private compareImagesResult: {
    similarity: number;
    pixelDifference: number;
    totalPixels: number;
  } = {
    similarity: 100,
    pixelDifference: 0,
    totalPixels: 2592000, // 1080 * 2400
  };

  // Call tracking
  private methodCalls: Map<string, Array<Record<string, unknown>>> = new Map();

  /**
   * Configure cached screenshot to return
   */
  setCachedScreenshot(filePath: string, buffer: Buffer, hash: string): void {
    this.cachedScreenshots.set(filePath, { buffer, hash });
  }

  /**
   * Configure image dimensions
   */
  setImageDimensions(width: number, height: number): void {
    this.imageDimensions = { width, height };
  }

  /**
   * Configure comparison result
   */
  setCompareImagesResult(result: {
    similarity: number;
    pixelDifference: number;
    totalPixels: number;
  }): void {
    this.compareImagesResult = result;
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

  // Implementation of ScreenshotUtils interface

  async getCachedScreenshot(filePath: string): Promise<{ buffer: Buffer; hash: string }> {
    this.recordCall("getCachedScreenshot", { filePath });
    const cached = this.cachedScreenshots.get(filePath);
    if (cached) {
      return cached;
    }
    // Default behavior: return a fake buffer and hash
    return {
      buffer: Buffer.from("fake screenshot data"),
      hash: "1111111111111111111111111111111111111111111111111111111111111111",
    };
  }

  async getImageDimensions(buffer: Buffer): Promise<{ width: number; height: number }> {
    this.recordCall("getImageDimensions", { bufferLength: buffer.length });
    return this.imageDimensions;
  }

  async compareImages(
    buffer1: Buffer,
    buffer2: Buffer,
    threshold: number = 0.1,
    fastMode: boolean = false,
  ): Promise<{
    similarity: number;
    pixelDifference: number;
    totalPixels: number;
    filePath?: string;
  }> {
    this.recordCall("compareImages", {
      buffer1Length: buffer1.length,
      buffer2Length: buffer2.length,
      threshold,
      fastMode,
    });
    return this.compareImagesResult;
  }
}
