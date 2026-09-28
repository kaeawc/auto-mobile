import type { TelemetryRepository } from "../../src/features/telemetry/TelemetryRecorder";
import type { RecordNetworkEventInput } from "../../src/db/networkEventRepository";
import type { RecordLogEventInput } from "../../src/db/logEventRepository";
import type { RecordOsEventInput } from "../../src/db/osEventRepository";
import type { RecordNavigationEventInput } from "../../src/db/navigationEventRepository";
import type { RecordStorageEventInput } from "../../src/db/storageEventRepository";
import type { RecordLayoutEventInput } from "../../src/db/layoutEventRepository";

export class FakeTelemetryRepository implements TelemetryRepository {
  readonly networkEvents: RecordNetworkEventInput[] = [];
  readonly logEvents: RecordLogEventInput[] = [];
  readonly osEvents: RecordOsEventInput[] = [];
  readonly navigationEvents: RecordNavigationEventInput[] = [];
  readonly storageEvents: RecordStorageEventInput[] = [];
  readonly layoutEvents: RecordLayoutEventInput[] = [];
  shouldThrow = false;
  private nextNetworkId = 1;

  private failIfRequested(): void {
    if (this.shouldThrow) {
      throw new Error("db error");
    }
  }

  async recordNetworkEvent(input: RecordNetworkEventInput): Promise<number> {
    this.failIfRequested();
    this.networkEvents.push(input);
    return this.nextNetworkId++;
  }

  async recordLogEvent(input: RecordLogEventInput): Promise<void> {
    this.failIfRequested();
    this.logEvents.push(input);
  }

  async recordOsEvent(input: RecordOsEventInput): Promise<void> {
    this.failIfRequested();
    this.osEvents.push(input);
  }

  async recordNavigationEvent(input: RecordNavigationEventInput): Promise<void> {
    this.failIfRequested();
    this.navigationEvents.push(input);
  }

  async recordStorageEvent(input: RecordStorageEventInput): Promise<void> {
    this.failIfRequested();
    this.storageEvents.push(input);
  }

  async recordLayoutEvent(input: RecordLayoutEventInput): Promise<void> {
    this.failIfRequested();
    this.layoutEvents.push(input);
  }
}
