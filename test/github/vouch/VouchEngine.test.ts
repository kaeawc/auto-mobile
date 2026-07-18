import { beforeEach, describe, expect, test } from "bun:test";
import { VouchEngine } from "../../../scripts/github/vouch/VouchEngine";
import { DEFAULT_VOUCH_POLICY, vouchCapacity } from "../../../scripts/github/vouch/VouchPolicy";
import { emptyVouchState, type VouchState } from "../../../scripts/github/vouch/types";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { FakeTimer } from "../../fakes/FakeTimer";
import { ActionableError } from "../../../src/models/ActionableError";

describe("VouchEngine", () => {
  let engine: VouchEngine;
  let timer: FakeTimer;
  let ids: CountingIdGenerator;
  let state: VouchState;

  beforeEach(() => {
    timer = new FakeTimer();
    ids = new CountingIdGenerator("tok");
    engine = new VouchEngine({ timer, idGenerator: ids, policy: DEFAULT_VOUCH_POLICY });
    state = emptyVouchState();
  });

  describe("seedMember", () => {
    test("creates an active founder with the configured initial reputation", () => {
      const owner = engine.seedMember(state, "Owner", "founder");
      expect(owner.login).toBe("owner"); // canonicalised
      expect(owner.role).toBe("founder");
      expect(owner.status).toBe("active");
      expect(owner.reputation).toBe(DEFAULT_VOUCH_POLICY.initialReputationByRole.founder);
      expect(owner.vouchedBy).toBeNull();
    });

    test("rejects seeding an already-known member", () => {
      engine.seedMember(state, "owner", "founder");
      expect(() => engine.seedMember(state, "owner", "contributor")).toThrow(ActionableError);
    });
  });

  describe("capacity", () => {
    test("adds one bonus vouch slot per reputation multiple", () => {
      // founder base 10, +bonus of floor(100/25)=4 => 14
      expect(vouchCapacity("founder", 100, DEFAULT_VOUCH_POLICY)).toBe(14);
      expect(vouchCapacity("vouched", 20, DEFAULT_VOUCH_POLICY)).toBe(2); // base 2 + floor(20/25)=0
      expect(vouchCapacity("vouched", 0, DEFAULT_VOUCH_POLICY)).toBe(2);
    });
  });

  describe("issueInvite", () => {
    test("issues a pending token and consumes budget", () => {
      engine.seedMember(state, "owner", "founder");
      const before = engine.remainingCapacity(state, "owner");
      const invite = engine.issueInvite(state, "owner");
      expect(invite.status).toBe("pending");
      expect(invite.issuedBy).toBe("owner");
      expect(invite.expiresAtMs).toBe(timer.now() + DEFAULT_VOUCH_POLICY.inviteTtlMs);
      expect(engine.remainingCapacity(state, "owner")).toBe(before - 1);
    });

    test("rejects a non-member issuer", () => {
      expect(() => engine.issueInvite(state, "ghost")).toThrow(ActionableError);
    });

    test("rejects once budget is exhausted", () => {
      const owner = engine.seedMember(state, "owner", "founder");
      const capacity = engine.capacity(owner);
      for (let i = 0; i < capacity; i++) {
        engine.issueInvite(state, "owner");
      }
      expect(engine.remainingCapacity(state, "owner")).toBe(0);
      expect(() => engine.issueInvite(state, "owner")).toThrow(/no remaining vouch budget/);
    });
  });

  describe("redeemInvite", () => {
    test("admits the redeemer as a vouched member linked to the issuer", () => {
      engine.seedMember(state, "owner", "founder");
      const invite = engine.issueInvite(state, "owner");
      const member = engine.redeemInvite(state, invite.token, "Newbie");
      expect(member.login).toBe("newbie");
      expect(member.role).toBe("vouched");
      expect(member.vouchedBy).toBe("owner");
      expect(member.redeemedToken).toBe(invite.token);
      expect(state.invites.get(invite.token)!.status).toBe("redeemed");
    });

    test("a redeemed invite still counts against the issuer's budget", () => {
      const owner = engine.seedMember(state, "owner", "founder");
      const capacity = engine.capacity(owner);
      const invite = engine.issueInvite(state, "owner");
      engine.redeemInvite(state, invite.token, "newbie");
      expect(engine.remainingCapacity(state, "owner")).toBe(capacity - 1);
    });

    test("rejects unknown / already-redeemed tokens", () => {
      engine.seedMember(state, "owner", "founder");
      const invite = engine.issueInvite(state, "owner");
      engine.redeemInvite(state, invite.token, "newbie");
      expect(() => engine.redeemInvite(state, invite.token, "other")).toThrow(/redeemed/);
      expect(() => engine.redeemInvite(state, "nope", "x")).toThrow(/Unknown invite/);
    });

    test("rejects an expired token", () => {
      engine.seedMember(state, "owner", "founder");
      const invite = engine.issueInvite(state, "owner");
      timer.setCurrentTime(invite.expiresAtMs + 1);
      expect(() => engine.redeemInvite(state, invite.token, "newbie")).toThrow(/expired/);
    });

    test("rejects a token whose issuer is no longer active", () => {
      engine.seedMember(state, "owner", "founder");
      const invite = engine.issueInvite(state, "owner");
      const first = engine.redeemInvite(state, invite.token, "midtier");
      const invite2 = engine.issueInvite(state, "midtier");
      engine.denounce(state, "midtier", "spam");
      expect(first.status).toBe("revoked");
      expect(() => engine.redeemInvite(state, invite2.token, "downstream")).toThrow(
        /issuer is no longer an active member/
      );
    });
  });

  describe("expireStaleInvites", () => {
    test("flips pending invites past their TTL to expired and frees budget", () => {
      engine.seedMember(state, "owner", "founder");
      const invite = engine.issueInvite(state, "owner");
      const before = engine.remainingCapacity(state, "owner");
      timer.setCurrentTime(invite.expiresAtMs + 1);
      engine.expireStaleInvites(state);
      expect(state.invites.get(invite.token)!.status).toBe("expired");
      expect(engine.remainingCapacity(state, "owner")).toBe(before + 1);
    });
  });

  describe("denounce", () => {
    test("refuses to denounce a founder (root of trust is immune)", () => {
      engine.seedMember(state, "owner", "founder");
      expect(() => engine.denounce(state, "owner", "anything")).toThrow(/immune/);
    });

    test("revokes the target and its whole downstream sub-tree", () => {
      engine.seedMember(state, "owner", "founder");
      const iA = engine.issueInvite(state, "owner");
      engine.redeemInvite(state, iA.token, "a");
      const iB = engine.issueInvite(state, "a");
      engine.redeemInvite(state, iB.token, "b");
      const iC = engine.issueInvite(state, "b");
      engine.redeemInvite(state, iC.token, "c");

      const result = engine.denounce(state, "a", "abuse");

      expect(result.revoked.map(m => m.login).sort()).toEqual(["a", "b", "c"]);
      expect(state.members.get("a")!.status).toBe("revoked");
      expect(state.members.get("a")!.revocationCause).toBe("denounced");
      expect(state.members.get("b")!.revocationCause).toBe("voucher-revoked");
      expect(state.members.get("c")!.status).toBe("revoked");
    });

    test("owner scenario: denouncing an invitee keeps the owner active but cuts their budget", () => {
      const owner = engine.seedMember(state, "owner", "founder");
      const capacityBefore = engine.capacity(owner);
      const iA = engine.issueInvite(state, "owner");
      engine.redeemInvite(state, iA.token, "a");

      const result = engine.denounce(state, "a", "abuse");

      // Owner is penalised but never revoked, and stays a founder.
      const ownerAfter = state.members.get("owner")!;
      expect(ownerAfter.status).toBe("active");
      expect(ownerAfter.role).toBe("founder");
      expect(result.penalised).toContainEqual({
        login: "owner",
        before: DEFAULT_VOUCH_POLICY.initialReputationByRole.founder,
        after: DEFAULT_VOUCH_POLICY.initialReputationByRole.founder - DEFAULT_VOUCH_POLICY.denouncePenalty,
      });
      // Lower reputation => strictly smaller vouch capacity.
      expect(engine.capacity(ownerAfter)).toBeLessThan(capacityBefore);
      // The freed slot (revoked invitee no longer commits budget) is reclaimable.
      expect(engine.remainingCapacity(state, "owner")).toBe(engine.capacity(ownerAfter));
    });

    test("penalty decays as it propagates up the chain", () => {
      engine.seedMember(state, "owner", "founder");
      const iA = engine.issueInvite(state, "owner");
      engine.redeemInvite(state, iA.token, "a");
      const iB = engine.issueInvite(state, "a");
      engine.redeemInvite(state, iB.token, "b");

      const ownerBefore = state.members.get("owner")!.reputation; // founder: 100

      engine.denounce(state, "b", "abuse");

      // Direct voucher (a, reputation 20) is charged the full penalty (30), which
      // floors at zero. Grand-voucher (owner) is charged the decayed penalty
      // (30 * 0.5 = 15), demonstrably less than the direct voucher's charge.
      expect(state.members.get("a")!.reputation).toBe(0);
      expect(state.members.get("owner")!.reputation).toBe(
        ownerBefore - DEFAULT_VOUCH_POLICY.denouncePenalty * DEFAULT_VOUCH_POLICY.penaltyDecay
      );
    });

    test("rejects denouncing an already-revoked member", () => {
      engine.seedMember(state, "owner", "founder");
      const iA = engine.issueInvite(state, "owner");
      engine.redeemInvite(state, iA.token, "a");
      engine.denounce(state, "a", "abuse");
      expect(() => engine.denounce(state, "a", "again")).toThrow(/already revoked/);
    });
  });

  describe("evaluateGate", () => {
    test("allows active members and denies unknown/revoked actors", () => {
      engine.seedMember(state, "owner", "founder");
      const iA = engine.issueInvite(state, "owner");
      engine.redeemInvite(state, iA.token, "a");

      expect(engine.evaluateGate(state, "owner").allowed).toBe(true);
      expect(engine.evaluateGate(state, "owner").reason).toBe("founder");
      expect(engine.evaluateGate(state, "A").allowed).toBe(true);
      expect(engine.evaluateGate(state, "A").reason).toBe("vouched");

      const unknown = engine.evaluateGate(state, "stranger");
      expect(unknown.allowed).toBe(false);
      expect(unknown.reason).toBe("unknown-actor");

      engine.denounce(state, "a", "abuse");
      const revoked = engine.evaluateGate(state, "a");
      expect(revoked.allowed).toBe(false);
      expect(revoked.reason).toBe("revoked");
    });
  });
});
