import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  bindFileBackedDbHarness,
  WINDOWS_FILE_DB_TEST_TIMEOUT_MS,
} from "../../db/withFileBackedDb";
import {
  EXPORT_IDENTITY,
  EXPORT_TOKEN,
  exportConfig,
  openExportHarness,
} from "./fixtures/exportHarness";

describe("session export restart recovery", () => {
  const getHarness = bindFileBackedDbHarness();
  test(
    "crash before first export read retains the grant and authenticates the original consumer after owner-exit recovery",
    async () => {
      const dbPath = join(await getHarness().makeTempDbDir("broker-export-"), "registry.sqlite");
      const original = await openExportHarness(dbPath);
      let grant;
      try {
        grant = await original.broker.prepare(
          exportConfig(),
          EXPORT_TOKEN,
          undefined,
          EXPORT_IDENTITY,
        );
        expect(grant.outcome).toBe("ready");
        // Simulate a crash after grant commit, without a client export read or graceful handoff.
      } finally {
        await original.registry.close();
      }
      const successorOwner = {
        ...original.options.owner,
        daemonId: "successor",
        pid: 202,
        processGenerationToken: "successor-generation",
      };
      const successor = await openExportHarness(dbPath, original.timer, successorOwner);
      try {
        const recovered = await successor.broker.getExport(
          EXPORT_IDENTITY.prepareId,
          EXPORT_IDENTITY.requestDigest,
          EXPORT_TOKEN,
        );
        expect(recovered?.result).toEqual(grant);
        successor.devices.canDestroy = false;
        await successor.broker.recover();
        expect((await successor.store.getRequest(exportConfig().requestId))?.owner).toEqual(
          successorOwner,
        );
        const afterExit = await successor.broker.getExport(
          EXPORT_IDENTITY.prepareId,
          EXPORT_IDENTITY.requestDigest,
          EXPORT_TOKEN,
        );
        expect(afterExit?.result).toMatchObject({
          outcome: "failed",
          sessionUuid: grant.sessionUuid,
          profile: grant.profile,
          cleanupPending: true,
          failure: { code: "session_owner_exited" },
        });
        expect(
          await successor.broker.acknowledgeExport(
            EXPORT_IDENTITY.prepareId,
            EXPORT_IDENTITY.requestDigest,
            EXPORT_TOKEN,
          ),
        ).toEqual({ prepareId: EXPORT_IDENTITY.prepareId, outcome: "acknowledged" });
        expect(successor.devices.prepared).toEqual([]);
      } finally {
        await successor.broker.close();
        await successor.registry.close();
      }
    },
    WINDOWS_FILE_DB_TEST_TIMEOUT_MS,
  );
});
