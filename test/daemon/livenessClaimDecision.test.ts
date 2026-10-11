import { describe, expect, test } from "bun:test";
import {
  decideLivenessClaim,
  mayAdoptUnownedLiveness,
  refusedClaimHoldSource,
  type LivenessClaimDecision,
  type LivenessClaimInput,
  type LivenessHoldState,
  type LivenessOwnerView,
} from "../../src/daemon/livenessClaimDecision";

// #11602: every combination of who claims, who owns the named session and its base, and where
// each owner's lease stands. The invariants are asserted over the whole table, so a rule placed
// in the wrong order fails here rather than in a hand-picked sequence.

const HOLDS: readonly LivenessHoldState[] = ["live", "suspect", "lapsed", "none"];
/** Tokens: `base` is the base owner's, `label` and `stranger` are others. */
const CLAIMANTS = ["label", "base", "stranger"] as const;

/** No owner, or an owner in each lease state. */
function ownerViews(tokens: readonly string[]): LivenessOwnerView[] {
  return [
    { ownerToken: undefined, hold: "none" },
    ...tokens.flatMap((ownerToken) => HOLDS.map((hold) => ({ ownerToken, hold }))),
  ];
}

const SESSION_VIEWS = ownerViews(["label", "base", "stranger"]);
/** `undefined` is a session that is not a derived label session. */
const BASE_VIEWS: Array<LivenessOwnerView | undefined> = [undefined, ...ownerViews(["base"])];

const TABLE: LivenessClaimInput[] = CLAIMANTS.flatMap((claimantToken) =>
  SESSION_VIEWS.flatMap((session) =>
    BASE_VIEWS.flatMap((base) =>
      [false, true].map((claimAlreadyProcessed) => ({
        claimantToken,
        session,
        claimAlreadyProcessed,
        base,
      })),
    ),
  ),
);

const holding = (view: LivenessOwnerView | undefined): boolean =>
  view?.ownerToken !== undefined && (view.hold === "live" || view.hold === "suspect");

/** The claim rule as it stood before a base was judged (2d413e046a): the named session alone. */
function decisionWithoutBase(input: LivenessClaimInput): LivenessClaimDecision["outcome"] {
  const { session, claimantToken } = input;
  if (session.ownerToken !== undefined && input.claimAlreadyProcessed) {
    return session.ownerToken === claimantToken ? "claimed" : "superseded";
  }
  return session.ownerToken !== claimantToken && holding(session) ? "conflict" : "claimed";
}

const describeRow = (input: LivenessClaimInput): string => JSON.stringify(input);

describe("decideLivenessClaim over every owner and lease combination", () => {
  test("the table covers each claimant against each session and base state", () => {
    expect(SESSION_VIEWS).toHaveLength(13);
    expect(BASE_VIEWS).toHaveLength(6);
    expect(TABLE).toHaveLength(3 * 13 * 6 * 2);
  });

  test("the current owner of the named session is never refused", () => {
    for (const input of TABLE.filter((row) => row.session.ownerToken === row.claimantToken)) {
      expect(decideLivenessClaim(input).outcome, describeRow(input)).toBe("claimed");
    }
  });

  test("the owner holding the base is never refused on its label", () => {
    const rows = TABLE.filter(
      (row) => holding(row.base) && row.base?.ownerToken === row.claimantToken,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const input of rows) {
      expect(decideLivenessClaim(input).outcome, describeRow(input)).toBe("claimed");
    }
  });

  test("no other token gains a label while the base's owner holds the base", () => {
    const rows = TABLE.filter(
      (row) =>
        holding(row.base) &&
        row.base?.ownerToken !== row.claimantToken &&
        row.session.ownerToken !== row.claimantToken,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const input of rows) {
      expect(decideLivenessClaim(input).outcome, describeRow(input)).not.toBe("claimed");
    }
  });

  test("a conflict names a hold that is live or in grace and is not the claimant's", () => {
    const conflicts = TABLE.flatMap((input) => {
      const decision = decideLivenessClaim(input);
      return decision.outcome === "conflict" ? [{ input, holdOf: decision.holdOf }] : [];
    });
    expect(conflicts.length).toBeGreaterThan(0);
    for (const { input, holdOf } of conflicts) {
      const holder = holdOf === "base" ? input.base : input.session;
      expect(holding(holder), describeRow(input)).toBe(true);
      expect(holder?.ownerToken, describeRow(input)).not.toBe(input.claimantToken);
      // The hold the handler reports afterwards, without the claimant's token, is that same one.
      expect(refusedClaimHoldSource(input.session, input.base), describeRow(input)).toBe(holdOf);
    }
  });

  test("a session with no base, or whose base nobody holds, is decided as before", () => {
    const rows = TABLE.filter((row) => !holding(row.base));
    expect(rows.length).toBeGreaterThan(0);
    for (const input of rows) {
      expect(decideLivenessClaim(input).outcome, describeRow(input)).toBe(
        decisionWithoutBase(input),
      );
    }
  });

  test("a held base changes the decision only for its own owner and for tokens it refuses", () => {
    for (const input of TABLE.filter((row) => holding(row.base))) {
      const before = decisionWithoutBase(input);
      const now = decideLivenessClaim(input).outcome;
      if (now === before) {
        continue;
      }
      const baseOwnerClaims = input.base?.ownerToken === input.claimantToken;
      expect(now, describeRow(input)).toBe(baseOwnerClaims ? "claimed" : "conflict");
      // Only a claim that would have won is turned into a conflict.
      expect(baseOwnerClaims || before === "claimed", describeRow(input)).toBe(true);
    }
  });

  test("a displaced token's retried claim stays superseded unless it now holds the base", () => {
    const rows = TABLE.filter(
      (row) =>
        row.claimAlreadyProcessed &&
        row.session.ownerToken !== undefined &&
        row.session.ownerToken !== row.claimantToken &&
        !(holding(row.base) && row.base?.ownerToken === row.claimantToken),
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const input of rows) {
      expect(decideLivenessClaim(input).outcome, describeRow(input)).toBe("superseded");
    }
  });
});

describe("mayAdoptUnownedLiveness over every owner and lease combination", () => {
  const ADOPTIONS = CLAIMANTS.flatMap((claimantToken) =>
    SESSION_VIEWS.flatMap((session) =>
      BASE_VIEWS.flatMap((base) =>
        [false, true].map((sessionHasClaimHistory) => ({
          claimantToken,
          session,
          sessionHasClaimHistory,
          base,
        })),
      ),
    ),
  );

  test("only an unowned session with no claim history is adopted, and never past a held base", () => {
    for (const input of ADOPTIONS) {
      const unowned = input.session.ownerToken === undefined && !input.sessionHasClaimHistory;
      const refusedByBase = holding(input.base) && input.base?.ownerToken !== input.claimantToken;
      expect(mayAdoptUnownedLiveness(input), JSON.stringify(input)).toBe(unowned && !refusedByBase);
    }
  });

  test("a session with no base, or whose base nobody holds, is adopted as before", () => {
    for (const input of ADOPTIONS.filter((row) => !holding(row.base))) {
      expect(mayAdoptUnownedLiveness(input), JSON.stringify(input)).toBe(
        input.session.ownerToken === undefined && !input.sessionHasClaimHistory,
      );
    }
  });
});
