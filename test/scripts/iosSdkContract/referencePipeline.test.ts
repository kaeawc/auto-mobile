import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Kysely } from "kysely";
import type { Database } from "../../../src/db/types";
import type { SdkEventBatchWire } from "../../../src/features/observe/ios/decodeSdkEventBatches";
import { ResourceRegistry } from "../../../src/server/resourceRegistry";
import { NetworkState } from "../../../src/utils/NetworkState";
import { replayNetworkBatch } from "../../../scripts/ios/sdk-contract/referencePipeline";
import { createTestDatabase } from "../../db/testDbHelper";
import { FakeTimer } from "../../fakes/FakeTimer";

// SDK-generated batches (see test/fixtures/ios-sdk-network/README.md).
const fixtures = join(import.meta.dir, "../../fixtures/ios-sdk-network");
const readBatch = (name: string) =>
  JSON.parse(readFileSync(join(fixtures, name), "utf8")) as SdkEventBatchWire;

let db: Kysely<Database>;
let state: NetworkState;
let stateSpy: ReturnType<typeof spyOn<typeof NetworkState, "getInstance">>;

beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(async () => {
  await db.deleteFrom("network_events").execute();
  state = new NetworkState({
    timer: new FakeTimer(),
    notifier: { notifyResourceUpdated: () => {} },
  });
  state.setCapture(true);
  stateSpy = spyOn(NetworkState, "getInstance").mockReturnValue(state);
});
afterEach(() => {
  stateSpy.mockRestore();
  state.dispose();
  ResourceRegistry.clearResources();
});

test("replays SDK bytes into the persisted row and the MCP request resource", async () => {
  const records = await replayNetworkBatch({
    db,
    deviceId: "contract-device",
    batch: readBatch("urlsession-full.json"),
    timer: new FakeTimer(),
  });
  expect(records.size).toBe(1);
  const [[requestId, record]] = [...records];
  expect(record.row.requestId).toBe(requestId);
  expect(record.row.deviceId).toBe("contract-device");
  expect(record.detail).toMatchObject({
    id: record.row.id,
    requestId,
    protocol: record.row.protocol,
    requestHeaders: { Authorization: "<redacted>" },
  });
});

test("keys every replayed transport by its SDK request id", async () => {
  const batch = readBatch("websocket.json");
  const records = await replayNetworkBatch({
    db,
    deviceId: "contract-device",
    batch,
    timer: new FakeTimer(),
  });
  expect([...records.values()].map(({ detail }) => detail.protocol)).toEqual(["websocket"]);
});

test("persists nothing while network capture is off, as the daemon would", async () => {
  state.setCapture(false);
  const records = await replayNetworkBatch({
    db,
    deviceId: "contract-device",
    batch: readBatch("urlsession.json"),
    timer: new FakeTimer(),
  });
  expect(records.size).toBe(0);
});
