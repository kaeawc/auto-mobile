import type { ArchiveExtractionRequest, ArchiveExtractor } from "../../src/utils/ArchiveExtractor";

/**
 * Fake {@link ArchiveExtractor} for tests. Records requests and lets a suite
 * install an effect (e.g. materialize the extracted files) or force a failure.
 */
export class FakeArchiveExtractor implements ArchiveExtractor {
  public readonly requests: ArchiveExtractionRequest[] = [];
  public shouldThrow: Error | null = null;
  public onExtract: ((request: ArchiveExtractionRequest) => Promise<void> | void) | null = null;

  async extractTarGz(request: ArchiveExtractionRequest): Promise<void> {
    this.requests.push(request);
    if (this.shouldThrow) {
      throw this.shouldThrow;
    }
    if (this.onExtract) {
      await this.onExtract(request);
    }
  }
}
