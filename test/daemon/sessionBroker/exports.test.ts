import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  SessionBroker,
  EXPORT_RETENTION_MS,
  RECEIPT_RETENTION_MS,
} from "../../../src/daemon/sessionBroker/broker";
import {
  SessionExportIdentityMismatchError,
  type BrokerAdmissionInput,
} from "../../../src/daemon/sessionBroker/store";
import {
  EXPORT_IDENTITY as IDENTITY,
  EXPORT_TOKEN as TOKEN,
  exportConfig as config,
  openExportHarness,
} from "./fixtures/exportHarness";

describe("pinned session exports", () => {
  let h: Awaited<ReturnType<typeof openExportHarness>>;
  beforeAll(async () => {
    const warm = await openExportHarness();
    await warm.registry.close();
  });
  beforeEach(async () => {
    h = await openExportHarness();
  });
  afterEach(async () => {
    await h.broker.close();
    await h.registry.close();
  });
  const prepare = (requestId = "request-1", identity = IDENTITY) =>
    h.broker.prepare(config(requestId), TOKEN, undefined, identity);
  const query = (digest = IDENTITY.requestDigest, token = TOKEN) =>
    h.broker.getExport(IDENTITY.prepareId, digest, token);
  const ack = (digest = IDENTITY.requestDigest, token = TOKEN) =>
    h.broker.acknowledgeExport(IDENTITY.prepareId, digest, token);

  test("export link commits with ready admission before native work", async () => {
    let observedExport;
    h.devices.prepareHook = async () => {
      observedExport = await h.store.getExport?.(IDENTITY.prepareId);
      expect(await h.store.getRequest("request-1")).toMatchObject({ state: "acquiring" });
    };
    const result = await prepare();
    expect(result.outcome).toBe("ready");
    expect(observedExport).toMatchObject({
      requestId: "request-1",
      requestDigest: IDENTITY.requestDigest,
      acknowledgedAtMs: null,
    });
    expect(await query()).toEqual({ contractVersion: 1, ...IDENTITY, acknowledged: false, result });
  });

  test("capacity refusal and catalog failure have linked no-grant terminal exports", async () => {
    await h.broker.prepare(config("occupant"), TOKEN);
    const refused = await prepare();
    expect(refused).toMatchObject({
      outcome: "failed",
      sessionUuid: null,
      failure: { code: "capacity_exhausted" },
    });
    expect((await query())?.result).toEqual(refused);
    h.options.catalog = async () => {
      throw new Error("catalog unavailable");
    };
    const other = { prepareId: "catalog", requestDigest: "catalog-digest" };
    const failed = await prepare("catalog-request", other);
    expect(failed).toMatchObject({
      outcome: "failed",
      sessionUuid: null,
      failure: { message: "catalog unavailable" },
    });
    expect((await h.broker.getExport(other.prepareId, other.requestDigest, TOKEN))?.result).toEqual(
      failed,
    );
  });

  test("native preparation failure exports the same terminal cleanup outcome", async () => {
    h.devices.prepareError = new Error("native preparation failed");
    h.devices.canDestroy = false;
    const failed = await prepare();
    expect(failed).toMatchObject({
      outcome: "failed",
      cleanupPending: true,
      failure: { message: "native preparation failed" },
    });
    expect((await query())?.result).toEqual(failed);
    expect(await prepare()).toEqual(failed);
  });

  test("store replay paths link or validate only after checking the fingerprint", async () => {
    const input: BrokerAdmissionInput = {
      requestId: "store-replay",
      fingerprint: "fp",
      parameters: {},
      owner: h.options.owner,
      limits: { totalDeviceCap: 0 },
      matches: () => false,
      resolveCreation: () => ({}),
    };
    await h.store.admit(input);
    const linked = { ...input, export: IDENTITY };
    expect((await h.store.admit(linked)).kind).toBe("existing");
    expect(await h.store.getExport(IDENTITY.prepareId)).toMatchObject({
      requestId: input.requestId,
    });
    const failure = { code: "catalog_failure", message: "catalog unavailable", retryable: false };
    expect((await h.store.recordPreAdmissionFailure(linked, failure)).requestId).toBe(
      input.requestId,
    );
    for (const call of [
      (value: BrokerAdmissionInput) => h.store.admit(value),
      (value: BrokerAdmissionInput) => h.store.recordPreAdmissionFailure(value, failure),
    ]) {
      await expect(call({ ...linked, fingerprint: "changed" })).rejects.toThrow(
        "different parameters",
      );
      await expect(
        call({ ...linked, export: { ...IDENTITY, requestDigest: "changed" } }),
      ).rejects.toMatchObject({ code: "session_export_identity_mismatch" });
    }
    await h.store.recordPreAdmissionFailure({ ...input, requestId: "pre-failed" }, failure);
    const other = { prepareId: "pre-failed", requestDigest: "other" };
    await h.store.recordPreAdmissionFailure(
      { ...input, requestId: "pre-failed", export: other },
      failure,
    );
    expect(await h.store.getExport(other.prepareId)).toMatchObject({
      requestId: "pre-failed",
      requestDigest: "other",
    });
  });

  test("prepareId collision rolls back admission and pre-admission failure receipts", async () => {
    await prepare();
    await expect(prepare("different-request")).rejects.toBeInstanceOf(
      SessionExportIdentityMismatchError,
    );
    expect(await h.store.getRequest("different-request")).toBeUndefined();
    h.options.catalog = async () => {
      throw new Error("catalog unavailable");
    };
    await expect(prepare("catalog-collision")).rejects.toBeInstanceOf(
      SessionExportIdentityMismatchError,
    );
    expect(await h.store.getRequest("catalog-collision")).toBeUndefined();
    expect(h.devices.prepared).toHaveLength(1);
  });

  test("failed reservation rolls back both request and export link", async () => {
    const input: BrokerAdmissionInput = {
      requestId: "rollback",
      fingerprint: "fp",
      parameters: {},
      owner: h.options.owner,
      limits: {},
      matches: () => false,
      resolveCreation: () => {
        throw new Error("resolve failed");
      },
      export: IDENTITY,
    };
    await expect(h.store.admit(input)).rejects.toThrow("resolve failed");
    expect(await h.store.getRequest("rollback")).toBeUndefined();
    expect(await h.store.getExport(IDENTITY.prepareId)).toBeUndefined();
  });

  test("replay links an existing receipt without catalog access and validates both identities", async () => {
    const result = await h.broker.prepare(config(), TOKEN);
    expect(await h.store.getExport(IDENTITY.prepareId)).toBeUndefined();
    h.options.catalog = async () => {
      throw new Error("replay must not read catalog");
    };
    expect(await prepare()).toEqual(result);
    expect(await prepare()).toEqual(result);
    for (const identity of [
      { ...IDENTITY, prepareId: "changed" },
      { ...IDENTITY, requestDigest: "changed" },
    ]) {
      await expect(prepare("request-1", identity)).rejects.toMatchObject({
        code: "session_export_identity_mismatch",
      });
    }
    expect((await query())?.result).toEqual(result);
    expect(h.devices.prepared).toHaveLength(1);
  });

  test("ack is idempotent, retains first time, and rejects digest and consumer mismatches before mutation", async () => {
    await prepare();
    for (const [digest, token] of [
      ["wrong", TOKEN],
      [IDENTITY.requestDigest, "wrong"],
    ]) {
      await expect(query(digest, token)).rejects.toMatchObject({
        code: "session_export_identity_mismatch",
      });
      await expect(ack(digest, token)).rejects.toMatchObject({
        code: "session_export_identity_mismatch",
      });
      expect((await h.store.getExport(IDENTITY.prepareId))?.acknowledgedAtMs).toBeNull();
    }
    h.timer.advanceTime(17);
    const expected = { prepareId: IDENTITY.prepareId, outcome: "acknowledged" } as const;
    expect(await ack()).toEqual(expected);
    const time = (await h.store.getExport(IDENTITY.prepareId))?.acknowledgedAtMs;
    expect(time).toBe(h.timer.now());
    h.timer.advanceTime(100);
    expect(await ack()).toEqual(expected);
    expect((await h.store.getExport(IDENTITY.prepareId))?.acknowledgedAtMs).toBe(time);
    expect((await query())?.acknowledged).toBe(true);
    expect(await h.broker.getExport("unknown", "digest", TOKEN)).toBeUndefined();
    expect(await h.broker.acknowledgeExport("unknown", "digest", TOKEN)).toEqual({
      prepareId: "unknown",
      outcome: "unknown_export",
    });
  });

  test("unacknowledged export survives normal receipt pruning; acknowledgement releases the pin", async () => {
    const ready = await prepare();
    await h.broker.release(ready.sessionUuid!);
    const terminal = await h.broker.status("request-1");
    h.timer.advanceTime(RECEIPT_RETENTION_MS + 1);
    expect(await h.broker.pruneReceipts()).toBe(0);
    expect((await query())?.result).toEqual(terminal);
    await ack();
    expect(await h.broker.pruneReceipts()).toBe(1);
    expect(await query()).toBeUndefined();
    expect(await h.store.getRequest("request-1")).toBeUndefined();
    expect(await h.store.listResources()).toEqual([]);
    expect(await ack()).toEqual({ prepareId: IDENTITY.prepareId, outcome: "unknown_export" });
  });

  test("unacknowledged pin expires at the default export ceiling without FK failure", async () => {
    const ready = await prepare();
    await h.broker.release(ready.sessionUuid!);
    h.timer.advanceTime(EXPORT_RETENTION_MS - 1);
    expect(await h.broker.pruneReceipts()).toBe(0);
    h.timer.advanceTime(1);
    expect(await h.broker.pruneReceipts()).toBe(1);
    expect(await query()).toBeUndefined();
    expect(await h.store.listResources()).toEqual([]);
  });

  test("export ceiling is injectable independently of the receipt window", async () => {
    h.broker = new SessionBroker({ ...h.options, exportRetentionMs: RECEIPT_RETENTION_MS + 10 });
    const ready = await prepare();
    await h.broker.release(ready.sessionUuid!);
    h.timer.advanceTime(RECEIPT_RETENTION_MS + 9);
    expect(await h.broker.pruneReceipts()).toBe(0);
    h.timer.advanceTime(1);
    expect(await h.broker.pruneReceipts()).toBe(1);
    expect(await query()).toBeUndefined();
  });

  test("pinned receipt preserves a shared tombstone when its later acknowledged owner is pruned", async () => {
    h.options.reuseCleanDevices = true;
    h.options.limits.idlePoolCap = 1;
    h.broker = new SessionBroker(h.options);
    const first = await prepare();
    await h.broker.release(first.sessionUuid!);
    const later = { prepareId: "later", requestDigest: "later" };
    await prepare("later-request", later);
    const resource = (await h.store.listResources())[0];
    const ticket = await h.store.fail("later-request", h.options.owner, "native failure");
    expect(ticket).toBeDefined();
    await h.devices.destroy(resource);
    expect(await h.store.confirmDestroyed(ticket!)).toBe(true);
    await h.broker.acknowledgeExport(later.prepareId, later.requestDigest, TOKEN);
    h.timer.advanceTime(RECEIPT_RETENTION_MS);
    expect(await h.broker.pruneReceipts()).toBe(1);
    expect(await h.store.getRequest("later-request")).toBeUndefined();
    expect(await h.store.getExport(later.prepareId)).toBeUndefined();
    expect(await h.store.listResources()).toMatchObject([
      { resourceId: resource.resourceId, state: "destroyed", requestId: null },
    ]);
    expect((await query())?.result).toMatchObject({
      sessionUuid: first.sessionUuid,
      profile: first.profile,
    });
  });

  test("non-opt-in result and replay are unchanged and create no export", async () => {
    const result = await h.broker.prepare(config(), TOKEN);
    expect(Object.keys(result).sort()).toEqual([
      "cleanupPending",
      "contractVersion",
      "outcome",
      "profile",
      "requestId",
      "sessionUuid",
    ]);
    expect(await h.broker.prepare(config(), TOKEN)).toEqual(result);
    expect(await query()).toBeUndefined();
  });
});
