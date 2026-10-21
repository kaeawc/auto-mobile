import { describe, expect, test } from "bun:test";
import type { TelemetryRepository } from "../../src/features/telemetry/TelemetryRecorder";
import type { RecordNetworkEventInput } from "../../src/db/networkEventRepository";
import type { RecordLogEventInput } from "../../src/db/logEventRepository";
import type { RecordOsEventInput } from "../../src/db/osEventRepository";
import type { RecordNavigationEventInput } from "../../src/db/navigationEventRepository";
import type { RecordStorageEventInput } from "../../src/db/storageEventRepository";
import type { RecordLayoutEventInput } from "../../src/db/layoutEventRepository";

/** What was persisted, read back oldest-first. */
export interface TelemetryReadback {
  network(): Promise<RecordNetworkEventInput[]>;
  log(): Promise<RecordLogEventInput[]>;
  os(): Promise<RecordOsEventInput[]>;
  navigation(): Promise<RecordNavigationEventInput[]>;
  storage(): Promise<RecordStorageEventInput[]>;
  layout(): Promise<RecordLayoutEventInput[]>;
}

export interface TelemetryRepositoryHandle {
  repository: TelemetryRepository;
  read: TelemetryReadback;
  dispose?: () => Promise<void>;
}

const base = { deviceId: "emulator-5554", applicationId: "com.example", sessionId: "s1" };

/**
 * Shared behavioural contract for {@link TelemetryRepository} (#11868): events recorded through
 * the fake and through the SQLite repositories read back identically.
 */
export function runTelemetryRepositoryContract(
  name: string,
  make: () => Promise<TelemetryRepositoryHandle>,
): void {
  const withRepository = async (
    body: (handle: TelemetryRepositoryHandle) => Promise<void>,
  ): Promise<void> => {
    const handle = await make();
    try {
      await body(handle);
    } finally {
      await handle.dispose?.();
    }
  };

  describe(`TelemetryRepository contract: ${name}`, () => {
    test("network events get increasing ids and read back with every field", () =>
      withRepository(async ({ repository, read }) => {
        const first: RecordNetworkEventInput = {
          ...base,
          timestamp: 100,
          url: "https://api.example.com/v1/items?id=1",
          method: "GET",
          statusCode: 200,
          durationMs: 12,
          requestBodySize: 0,
          responseBodySize: 42,
          protocol: "h2",
          requestId: "r1",
          connectionId: "c1",
          direction: "outbound",
          metadata: { source: "okhttp" },
          sequenceNumber: 3,
          host: "api.example.com",
          path: "/v1/items",
          error: null,
          requestHeaders: { accept: "application/json" },
          responseHeaders: { "content-type": "application/json" },
          requestBody: null,
          responseBody: '{"ok":true}',
          contentType: "application/json",
        };
        const second: RecordNetworkEventInput = {
          ...first,
          timestamp: 200,
          method: "POST",
          statusCode: 500,
          error: "boom",
        };
        const firstId = await repository.recordNetworkEvent(first);
        const secondId = await repository.recordNetworkEvent(second);
        expect(firstId).toBe(1);
        expect(secondId).toBe(2);
        expect(await read.network()).toEqual([first, second]);
      }));

    test("log events read back", () =>
      withRepository(async ({ repository, read }) => {
        const event: RecordLogEventInput = {
          ...base,
          timestamp: 100,
          level: 4,
          tag: "OkHttp",
          message: "request failed",
          filterName: "errors",
        };
        await repository.recordLogEvent(event);
        expect(await read.log()).toEqual([event]);
      }));

    test("os events read back, including structured details", () =>
      withRepository(async ({ repository, read }) => {
        const event: RecordOsEventInput = {
          ...base,
          timestamp: 100,
          category: "lifecycle",
          kind: "resumed",
          details: { activity: "MainActivity" },
        };
        const bare: RecordOsEventInput = { ...event, timestamp: 200, details: null };
        await repository.recordOsEvent(event);
        await repository.recordOsEvent(bare);
        expect(await read.os()).toEqual([event, bare]);
      }));

    test("navigation events read back", () =>
      withRepository(async ({ repository, read }) => {
        const event: RecordNavigationEventInput = {
          ...base,
          timestamp: 100,
          destination: "settings",
          source: "home",
          arguments: { tab: "1" },
          metadata: { framework: "compose" },
        };
        await repository.recordNavigationEvent(event);
        expect(await read.navigation()).toEqual([event]);
      }));

    test("layout events read back with a defaulted screen name", () =>
      withRepository(async ({ repository, read }) => {
        const event: RecordLayoutEventInput = {
          ...base,
          timestamp: 100,
          subType: "recomposition",
          composableName: "Row",
          composableId: "c-1",
          recompositionCount: 7,
          durationMs: 3,
          likelyCause: "state",
          detailsJson: '{"a":1}',
        };
        await repository.recordLayoutEvent(event);
        expect(await read.layout()).toEqual([{ ...event, screenName: null }]);
      }));

    test("storage events are canonicalized and carry the previous value of their key", () =>
      withRepository(async ({ repository, read }) => {
        const first: RecordStorageEventInput = {
          ...base,
          timestamp: 100,
          fileName: "prefs.xml",
          key: "theme",
          value: "dark",
          valueType: "  STRING ",
          changeType: "add",
        };
        await repository.recordStorageEvent(first);
        await repository.recordStorageEvent({
          ...first,
          timestamp: 200,
          value: "light",
          valueType: null,
          changeType: "",
        });
        // An explicit null previous value asserts "no prior value" and suppresses the lookup.
        await repository.recordStorageEvent({
          ...first,
          timestamp: 300,
          value: "auto",
          previousValue: null,
        });
        // Another key and another file never inherit a previous value.
        await repository.recordStorageEvent({ ...first, timestamp: 400, key: "other" });
        await repository.recordStorageEvent({ ...first, timestamp: 500, fileName: "other.xml" });
        expect(await read.storage()).toEqual([
          { ...first, valueType: "string", previousValue: null },
          {
            ...first,
            timestamp: 200,
            value: "light",
            valueType: "unknown",
            changeType: "modify",
            previousValue: "dark",
          },
          { ...first, timestamp: 300, value: "auto", valueType: "string", previousValue: null },
          { ...first, timestamp: 400, key: "other", valueType: "string", previousValue: null },
          {
            ...first,
            timestamp: 500,
            fileName: "other.xml",
            valueType: "string",
            previousValue: null,
          },
        ]);
      }));
  });
}
