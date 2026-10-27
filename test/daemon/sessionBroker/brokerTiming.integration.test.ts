import { beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  bindFileBackedDbHarness,
  WINDOWS_FILE_DB_TEST_TIMEOUT_MS,
} from "../../db/withFileBackedDb";
import { SessionBroker } from "../../../src/daemon/sessionBroker/broker";
import { openExportHarness, exportConfig } from "./fixtures/exportHarness";

describe("broker timing restart persistence", () => {
  const getHarness = bindFileBackedDbHarness();
  let original: Awaited<ReturnType<typeof openExportHarness>>;
  let dbPath: string;
  beforeEach(async () => {
    dbPath = join(await getHarness().makeTempDbDir("broker-timing-"), "registry.sqlite");
    original = await openExportHarness(dbPath);
  });
  test(
    "acquisition and reset survive closing and reopening the registry",
    async () => {
      await original.broker.close();
      const broker = new SessionBroker({ ...original.options, timer: original.timer });
      let timing;
      try {
        const ready = await broker.prepare(exportConfig(), "token");
        timing = (await broker.release(ready.sessionUuid!)).timing;
        expect(timing?.reset?.outcome).toBe("destroyed");
      } finally {
        await broker.close();
        await original.registry.close();
      }
      const successor = await openExportHarness(dbPath, original.timer);
      await successor.broker.close();
      const reopened = new SessionBroker({ ...successor.options, timer: successor.timer });
      try {
        expect((await reopened.status(exportConfig().requestId))?.timing).toEqual(timing);
        expect((await reopened.stats()).groups[0]).toMatchObject({
          acquisitions: 1,
          resets: 1,
          retirements: 1,
        });
      } finally {
        await reopened.close();
        await successor.registry.close();
      }
    },
    WINDOWS_FILE_DB_TEST_TIMEOUT_MS,
  );
});
