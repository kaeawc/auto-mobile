import { describe, test } from "bun:test";
import fc from "fast-check";
import {
  parseTrickleFragment,
  serializeTrickleFragment,
  type TrickleCandidate,
  type TrickleIceMediaContext,
} from "../../../src/features/webrtc/trickleIce";

// Property-based tests. See test/utils/Backoff.property.test.ts for the
// pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

// ICE candidate attribute bodies look like "0 1 UDP 2130706431 10.0.0.1 54400
// typ host". Generated loosely (no embedded CR/LF, since a real candidate
// line is one SDP line) but with enough token variety to exercise the
// "candidate:" prefix handling.
const candidateBody = fc
  .array(fc.stringMatching(/^[a-zA-Z0-9.:_-]{1,10}$/), { minLength: 3, maxLength: 8 })
  .map(tokens => tokens.join(" "));

const trickleCandidate: fc.Arbitrary<TrickleCandidate> = fc.record({
  candidate: candidateBody,
  sdpMid: fc.option(fc.stringMatching(/^[a-zA-Z0-9_-]{1,8}$/), { nil: undefined }),
});

const mediaContext: fc.Arbitrary<TrickleIceMediaContext> = fc.record({
  mLine: fc.constant("m=audio 9 UDP/TLS/RTP/SAVPF 0"),
  mid: fc.stringMatching(/^[a-zA-Z0-9_-]{1,8}$/),
  ice: fc.record({
    ufrag: fc.stringMatching(/^[a-zA-Z0-9]{4,10}$/),
    pwd: fc.stringMatching(/^[a-zA-Z0-9]{22,32}$/),
  }),
});

describe("trickleIce parse/serialize (property-based)", () => {
  test("round-trip: parsing a serialized candidate recovers its candidate line", () => {
    fc.assert(
      fc.property(trickleCandidate, mediaContext, (candidate, context) => {
        const fragment = serializeTrickleFragment(candidate, context);
        const [parsed] = parseTrickleFragment(fragment);
        const expectedCandidateLine = candidate.candidate.startsWith("candidate:")
          ? candidate.candidate.trim()
          : `candidate:${candidate.candidate.trim()}`;
        return parsed !== undefined && parsed.candidate === expectedCandidateLine;
      }),
      RUN_OPTIONS
    );
  });

  test("round-trip: the parsed mid falls back to the context mid when the candidate has none", () => {
    fc.assert(
      fc.property(trickleCandidate, mediaContext, (candidate, context) => {
        const fragment = serializeTrickleFragment(candidate, context);
        const [parsed] = parseTrickleFragment(fragment);
        const expectedMid = candidate.sdpMid ?? context.mid;
        return parsed !== undefined && parsed.sdpMid === expectedMid;
      }),
      RUN_OPTIONS
    );
  });

  test("serialize always emits exactly one candidate parseable back out", () => {
    fc.assert(
      fc.property(trickleCandidate, mediaContext, (candidate, context) => {
        const fragment = serializeTrickleFragment(candidate, context);
        return parseTrickleFragment(fragment).length === 1;
      }),
      RUN_OPTIONS
    );
  });

  test("parseTrickleFragment is total: never throws on arbitrary text", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), fragment => {
        parseTrickleFragment(fragment);
        return true;
      }),
      RUN_OPTIONS
    );
  });
});
