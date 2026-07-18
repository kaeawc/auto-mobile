import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import type { Database } from "../../src/db/types";
import { createTestDatabase } from "./testDbHelper";
import { orderMembersForInsert, VouchRepository } from "../../src/db/vouchRepository";
import { VouchService } from "../../src/features/vouch/VouchService";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";

describe("VouchRepository + VouchService", () => {
  let db: Kysely<Database>;
  let repository: VouchRepository;
  let service: VouchService;
  let timer: FakeTimer;

  beforeEach(async () => {
    // Foreign keys ON so the self-referential vouched_by FK is exercised.
    db = await createTestDatabase({ foreignKeys: true });
    repository = new VouchRepository(db);
    timer = new FakeTimer();
    service = new VouchService({
      repository,
      timer,
      idGenerator: new CountingIdGenerator("tok"),
    });
  });

  afterEach(async () => {
    await db.destroy();
  });

  test("persists a seeded founder across loads", async () => {
    await service.seedMember("Owner", "founder");
    const reloaded = await repository.loadState();
    const owner = reloaded.members.get("owner");
    expect(owner).toBeDefined();
    expect(owner!.role).toBe("founder");
    expect(owner!.status).toBe("active");
  });

  test("round-trips an invite → redeem → denounce lifecycle through the DB", async () => {
    await service.seedMember("owner", "founder");
    const invite = await service.issueInvite("owner");
    expect(invite.status).toBe("pending");

    await service.redeemInvite(invite.token, "newbie");
    expect((await service.evaluateGate("newbie")).allowed).toBe(true);

    const result = await service.denounce("newbie", "spam");
    expect(result.revoked.map(m => m.login)).toEqual(["newbie"]);

    const gate = await service.evaluateGate("newbie");
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toBe("revoked");

    // Persisted invite reflects the redemption.
    const state = await repository.loadState();
    expect(state.invites.get(invite.token)!.status).toBe("redeemed");
    expect(state.invites.get(invite.token)!.redeemedBy).toBe("newbie");
  });

  test("saveState inserts vouchers before their invitees (FK-safe ordering)", async () => {
    await service.seedMember("owner", "founder");
    const iA = await service.issueInvite("owner");
    await service.redeemInvite(iA.token, "a");
    const iB = await service.issueInvite("a");
    await service.redeemInvite(iB.token, "b");

    // A full re-save of the loaded state must not violate the vouched_by FK.
    const state = await repository.loadState();
    await expect(repository.saveState(state)).resolves.toBeUndefined();
  });

  test("gate on an empty graph fails safe-closed for an unknown actor", async () => {
    const gate = await service.evaluateGate("stranger");
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toBe("unknown-actor");
  });

  test("orderMembersForInsert places vouchers ahead of their invitees", () => {
    const now = 0;
    const base = {
      status: "active" as const,
      reputation: 10,
      redeemedToken: null,
      revocationCause: null,
      revocationReason: null,
      createdAtMs: now,
      updatedAtMs: now,
    };
    const b = { login: "b", role: "vouched" as const, vouchedBy: "a", ...base };
    const a = { login: "a", role: "vouched" as const, vouchedBy: "owner", ...base };
    const owner = { login: "owner", role: "founder" as const, vouchedBy: null, ...base };

    const ordered = orderMembersForInsert([b, a, owner]).map(m => m.login);
    expect(ordered.indexOf("owner")).toBeLessThan(ordered.indexOf("a"));
    expect(ordered.indexOf("a")).toBeLessThan(ordered.indexOf("b"));
  });
});
