import { Database as BunDatabase } from "bun:sqlite";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "../../../src/db/bunSqliteDialect";
import { InMemoryDbWriteBarrier } from "../../../src/db/dbWriteBarrier";
import { runMigrations } from "../../../src/db/migrator";
import {
  getNetworkEventById,
  getNetworkEvents,
  recordNetworkEvent,
  type NetworkEventWithId,
} from "../../../src/db/networkEventRepository";
import type { Database } from "../../../src/db/types";
import { DefaultIosSdkEventIngestor } from "../../../src/features/observe/ios/IosSdkEventIngestor";
import {
  decodeSdkEventBatches,
  type SdkEventBatchWire,
} from "../../../src/features/observe/ios/decodeSdkEventBatches";
import {
  TelemetryRecorder,
  getNoOpTelemetryRepository,
} from "../../../src/features/telemetry/TelemetryRecorder";
import { registerNetworkResources } from "../../../src/server/networkResources";
import { ResourceRegistry } from "../../../src/server/resourceRegistry";
import { defaultTimer, type Timer } from "../../../src/utils/SystemTimer";

/** What the production TypeScript path makes of the SDK's bytes, keyed by SDK request id. */
export interface ReferenceNetworkRecord {
  row: NetworkEventWithId;
  detail: Record<string, unknown>;
}

const MAX_REPLAYED_EVENTS = 1000;

/** A private in-memory database at the current schema; never the user's file-backed DB. */
export async function createReferenceDatabase(): Promise<Kysely<Database>> {
  const db = new Kysely<Database>({
    dialect: new BunSqliteDialect({ database: new BunDatabase(":memory:") }),
  });
  await runMigrations(db as Kysely<unknown>);
  return db;
}

/** Reads `automobile:network/request/{id}` through the registered MCP resource handler. */
export async function readRequestResource(id: number): Promise<Record<string, unknown>> {
  const uri = `automobile:network/request/${id}`;
  const match = ResourceRegistry.matchTemplate(uri);
  if (!match) {
    throw new Error(`no resource template matches ${uri}`);
  }
  const content =
    "handler" in match.template
      ? await match.template.handler(match.params)
      : await match.template.handlerWithReadContext(match.params, {});
  return JSON.parse(content.text ?? "{}") as Record<string, unknown>;
}

/**
 * Replays the SDK's encoded batch through the same decoder, ingestor, repository and MCP
 * resource the daemon uses, minus CtrlProxy. A live result that differs from this replay
 * therefore points at the transport, and a replay that differs from the SDK payload points
 * at the TypeScript side. Network capture must be on in this process (`NetworkState`), as
 * it must be in the daemon, or the recorder drops the rows.
 */
export async function replayNetworkBatch(options: {
  db: Kysely<Database>;
  deviceId: string;
  batch: SdkEventBatchWire;
  timer?: Timer;
}): Promise<Map<string, ReferenceNetworkRecord>> {
  const { db, deviceId, batch } = options;
  const timer = options.timer ?? defaultTimer;
  const barrier = new InMemoryDbWriteBarrier(timer);
  const recorder = new TelemetryRecorder(
    {
      ...getNoOpTelemetryRepository(),
      recordNetworkEvent: (event) => recordNetworkEvent(event, db),
    },
    () => null,
    () => barrier,
  );
  const ingestor = new DefaultIosSdkEventIngestor({
    deviceId,
    timer,
    getNavigationGraphManager: () => ({
      recordNavigationEvent: async () => {},
      updateNodeScreenshot: async () => {},
    }),
    captureScreenshot: async () => ({ success: false }),
    telemetryRecorder: recorder,
    navigationScreenshotsEnabled: () => false,
  });
  const decoded = decodeSdkEventBatches([batch], () => timer.now());
  for (const event of decoded.events) {
    await ingestor.recordSdkEvent(
      { type: event.eventType, timestamp: event.timestamp, payload: event.payload },
      event.applicationId ?? null,
    );
  }
  registerNetworkResources({
    getNetworkEvents: (query) => getNetworkEvents(query, db),
    getNetworkEventById: (id) => getNetworkEventById(id, db),
  });
  const records = new Map<string, ReferenceNetworkRecord>();
  for (const row of await getNetworkEvents({ deviceId, limit: MAX_REPLAYED_EVENTS }, db)) {
    if (row.requestId) {
      records.set(row.requestId, { row, detail: await readRequestResource(row.id) });
    }
  }
  return records;
}
