import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  parseTrickleFragment,
  serializeEndOfCandidates,
  serializeTrickleFragment,
  type TrickleCandidate,
  type TrickleIceMediaContext,
} from "../../../src/features/webrtc/trickleIce";

// Property-based round-trip tests for the pure trickle-ICE serializer/parser.
// Candidate/mid values are drawn from the real single-line domain (SDP fragment
// lines carry no CR/LF by construction) but deliberately exercise embedded colons
// and internal whitespace — the edge cases hand-picked examples miss. See
// test/utils/Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 200 } as const;

/** SDP token (mid/ufrag/pwd): non-empty, no whitespace or line breaks. */
const token = fc.stringMatching(/^[A-Za-z0-9_+/-]{1,24}$/);

/** A candidate payload: any single-line string (colons and spaces allowed, no CR/LF). */
const candidatePayload = fc.string({ maxLength: 48 }).filter((s) => !/[\r\n]/.test(s));

/** An m-line, constrained to start with `m=` so it cannot masquerade as a=mid/a=candidate. */
const mLine = fc.stringMatching(/^m=[A-Za-z0-9 /]+$/).filter((s) => s.length > 2);

const contextArb: fc.Arbitrary<TrickleIceMediaContext> = fc.record({
  mLine,
  mid: token,
  ice: fc.record({ ufrag: token, pwd: token }),
});

const candidateArb: fc.Arbitrary<TrickleCandidate> = fc.record(
  { candidate: candidatePayload, sdpMid: fc.option(token, { nil: undefined }) },
  { requiredKeys: ["candidate"] },
);

/** The documented normalization: ensure the `candidate:` prefix exactly once, trimmed. */
function expectedCandidateLine(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.startsWith("candidate:") ? trimmed : `candidate:${trimmed}`;
}

describe("trickleIce round-trip (property-based)", () => {
  test("parse(serialize(candidate)) recovers the normalized candidate and mid", () => {
    fc.assert(
      fc.property(candidateArb, contextArb, (candidate, context) => {
        const parsed = parseTrickleFragment(serializeTrickleFragment(candidate, context));
        expect(parsed).toHaveLength(1);
        expect(parsed[0].candidate).toBe(expectedCandidateLine(candidate.candidate));
        expect(parsed[0].sdpMid).toBe(candidate.sdpMid ?? context.mid);
      }),
      RUN_OPTIONS,
    );
  });

  test("idempotence: re-serializing a parsed candidate reproduces it exactly", () => {
    fc.assert(
      fc.property(candidateArb, contextArb, (candidate, context) => {
        const first = parseTrickleFragment(serializeTrickleFragment(candidate, context))[0];
        const second = parseTrickleFragment(serializeTrickleFragment(first, context))[0];
        expect(second).toEqual(first);
      }),
      RUN_OPTIONS,
    );
  });

  test("multi-candidate: every candidate under one mid is recovered and attributed", () => {
    const arb = fc.tuple(fc.array(candidatePayload, { minLength: 1, maxLength: 6 }), contextArb);
    fc.assert(
      fc.property(arb, ([payloads, context]) => {
        // A single fragment: the mid line once, then several candidate lines.
        const lines = [
          context.mLine,
          `a=mid:${context.mid}`,
          ...payloads.map((p) => `a=${expectedCandidateLine(p)}`),
        ];
        const parsed = parseTrickleFragment(`${lines.join("\r\n")}\r\n`);
        expect(parsed).toHaveLength(payloads.length);
        for (let i = 0; i < payloads.length; i++) {
          expect(parsed[i].candidate).toBe(expectedCandidateLine(payloads[i]));
          expect(parsed[i].sdpMid).toBe(context.mid);
        }
      }),
      RUN_OPTIONS,
    );
  });

  test("end-of-candidates fragments parse to no candidates", () => {
    fc.assert(
      fc.property(contextArb, (context) => {
        expect(parseTrickleFragment(serializeEndOfCandidates(context))).toEqual([]);
      }),
      RUN_OPTIONS,
    );
  });
});
