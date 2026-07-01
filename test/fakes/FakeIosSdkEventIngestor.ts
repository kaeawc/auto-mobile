import type { SdkEvent } from "../../src/features/observe/interfaces/SdkEventIngestor";
import type { IosSdkEventIngestor } from "../../src/features/observe/ios/IosSdkEventIngestor";
import type { ViewHierarchyResult } from "../../src/models";

/**
 * Fake IosSdkEventIngestor for testing the client's forwarding behavior.
 * Records every forwarded event/hierarchy in memory for verification.
 */
export class FakeIosSdkEventIngestor implements IosSdkEventIngestor {
  public readonly sdkEvents: Array<{ event: SdkEvent; applicationId: string | null }> = [];
  public readonly layoutEvents: ViewHierarchyResult[] = [];

  async recordSdkEvent(event: SdkEvent, applicationId: string | null): Promise<void> {
    this.sdkEvents.push({ event, applicationId });
  }

  recordLayoutTelemetryEvent(hierarchy: ViewHierarchyResult): void {
    this.layoutEvents.push(hierarchy);
  }
}
