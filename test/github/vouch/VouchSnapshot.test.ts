import { describe, expect, test } from "bun:test";
import { VouchEngine } from "../../../scripts/github/vouch/VouchEngine";
import { emptyVouchState } from "../../../scripts/github/vouch/types";
import {
  parseVouchState,
  serializeVouchState,
  stringifyVouchState,
  VOUCH_SNAPSHOT_VERSION,
} from "../../../scripts/github/vouch/VouchSnapshot";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { FakeTimer } from "../../fakes/FakeTimer";

describe("VouchSnapshot", () => {
  function buildState() {
    const engine = new VouchEngine({
      timer: new FakeTimer(),
      idGenerator: new CountingIdGenerator("tok"),
    });
    const state = emptyVouchState();
    engine.seedMember(state, "owner", "founder");
    const invite = engine.issueInvite(state, "owner");
    engine.redeemInvite(state, invite.token, "newbie");
    return state;
  }

  test("round-trips state through JSON without loss", () => {
    const state = buildState();
    const restored = parseVouchState(stringifyVouchState(state));

    expect(restored.members.size).toBe(state.members.size);
    expect(restored.invites.size).toBe(state.invites.size);
    expect(restored.members.get("newbie")!.vouchedBy).toBe("owner");
    expect([...restored.invites.values()][0]!.status).toBe("redeemed");
  });

  test("serializes with a version and sorted, diff-friendly ordering", () => {
    const snapshot = serializeVouchState(buildState());
    expect(snapshot.version).toBe(VOUCH_SNAPSHOT_VERSION);
    const logins = snapshot.members.map(m => m.login);
    expect(logins).toEqual([...logins].sort());
  });

  test("parses an empty string as an empty graph", () => {
    const state = parseVouchState("");
    expect(state.members.size).toBe(0);
    expect(state.invites.size).toBe(0);
  });
});
