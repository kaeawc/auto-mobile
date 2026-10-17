import type { TelemetryRepository } from "../../src/features/telemetry/TelemetryRecorder";
import type { RecordNetworkEventInput } from "../../src/db/networkEventRepository";
import type { RecordLogEventInput } from "../../src/db/logEventRepository";
import type { RecordOsEventInput } from "../../src/db/osEventRepository";
import type { RecordNavigationEventInput } from "../../src/db/navigationEventRepository";
import {
  normalizeStorageEvent,
  type RecordStorageEventInput,
} from "../../src/db/storageEventRepository";
import type { RecordLayoutEventInput } from "../../src/db/layoutEventRepository";

/**
 * Held to the same behavioural contract as the SQLite repositories
 * (test/contracts/TelemetryRepositoryContract.ts): layout events default `screenName` to null,
 * and storage events are canonicalized and inherit the previous value of their key exactly as
 * the real recorder does.
 */
export class FakeTelemetryRepository implements TelemetryRepository {
  readonly networkEvents: RecordNetworkEventInput[] = [];
  readonly logEvents: RecordLogEventInput[] = [];
  readonly osEvents: RecordOsEventInput[] = [];
  readonly navigationEvents: RecordNavigationEventInput[] = [];
  /** Persisted rows, canonicalized like the real recorder. */
  readonly storageEvents: RecordStorageEventInput[] = [];
  /** The inputs exactly as the caller passed them, for asserting what a recorder forwards. */
  readonly storageInputs: RecordStorageEventInput[] = [];
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
    this.storageInputs.push(input);
    const event = normalizeStorageEvent(input);
    let previousValue = event.previousValue;
    if (previousValue === undefined) {
      const lookup = event.key !== null && event.deviceId !== null;
      const previous = lookup
        ? [...this.storageEvents]
            .reverse()
            .find(
              (stored) =>
                stored.deviceId === event.deviceId &&
                stored.fileName === event.fileName &&
                stored.key === event.key,
            )
        : undefined;
      previousValue = previous?.value ?? null;
    }
    this.storageEvents.push({ ...event, previousValue });
  }

  async recordLayoutEvent(input: RecordLayoutEventInput): Promise<void> {
    this.failIfRequested();
    this.layoutEvents.push({ ...input, screenName: input.screenName ?? null });
  }
}
