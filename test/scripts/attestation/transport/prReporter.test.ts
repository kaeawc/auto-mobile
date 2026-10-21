import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  PrDecisionReporter,
  decisionReasonText,
} from "../../../../scripts/ci/attestation/transport/prReporter";
import { decisionReasons } from "../../../../scripts/ci/attestation/transport/types";
import { logger } from "../../../../src/utils/logger";
import {
  CANARY,
  expectedDecisionReasons,
  FakeTokenProvider,
  flushMicrotasks,
  harness,
  query,
  response,
} from "./fakes";

describe("informational PR check reporter", () => {
  let warn: ReturnType<typeof spyOn<typeof logger, "warn">>;
  beforeEach(() => {
    warn = spyOn(logger, "warn").mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  test.each([
    ["tier", 0],
    ["tier", 4],
    ["tier", 1.5],
    ["tier", NaN],
    ["tier", Infinity],
    ["tier", Number.MAX_SAFE_INTEGER + 1],
    ["sha", "a".repeat(39)],
    ["sha", "a".repeat(41)],
    ["sha", "A".repeat(40)],
    ["sha", "g".repeat(40)],
    ["sha", "a".repeat(63)],
    ["sha", "a".repeat(65)],
    ["sha", `${"a".repeat(40)}\n`],
    ["sha", null],
    ["decision", { kind: "grant", reason: "verified-match" }],
    ["decision", { kind: "skip", reason: "unknown" }],
    ["decision", { kind: "skip", reason: "verified-match", detail: {} }],
    ["decision", null],
  ] as const)("invalid %s (%j) warns before auth or fetch", async (field, value) => {
    const h = harness();
    const tokenProvider = new FakeTokenProvider();
    const report = { ...query, decision: { kind: "skip", reason: "verified-match" } as const };
    Reflect.set(report, field, value);
    await new PrDecisionReporter({ ...h, tokenProvider }).report(report);
    expect(tokenProvider.calls).toHaveLength(0);
    expect(h.http.calls).toHaveLength(0);
    expect(warn.mock.calls).toEqual([["Attestation check report invalid; nothing sent."]]);
  });

  for (const kind of ["skip", "advisory"] as const) {
    test.each(decisionReasons.filter((reason) => !expectedDecisionReasons[kind].includes(reason)))(
      `invalid ${kind} / %s warns before auth or fetch`,
      async (reason) => {
        const h = harness();
        const tokenProvider = new FakeTokenProvider();
        await new PrDecisionReporter({ ...h, tokenProvider }).report({
          ...query,
          decision: { kind, reason },
        });
        expect(tokenProvider.calls).toHaveLength(0);
        expect(h.http.calls).toHaveLength(0);
        expect(warn.mock.calls).toEqual([["Attestation check report invalid; nothing sent."]]);
      },
    );
  }

  test.each([1, 2, 3])("accepts tier %s and SHA-256 repository commits", async (tier) => {
    const h = harness();
    const tokenProvider = new FakeTokenProvider();
    const sha = "c".repeat(64);
    await new PrDecisionReporter({ ...h, tokenProvider }).report({
      ...query,
      sha,
      tier,
      decision: { kind: "ignore", reason: "stale" },
    });
    expect(h.http.calls).toHaveLength(1);
    expect(JSON.parse(h.http.calls[0]!.init.body!)).toMatchObject({
      name: `attestation / tier-${tier}`,
      head_sha: sha,
    });
  });

  for (const kind of ["skip", "advisory", "ignore"] as const) {
    test.each([...expectedDecisionReasons[kind]])(`${kind} reports reason %s`, async (reason) => {
      const h = harness();
      h.http.queue.push(response({ id: 123 }));
      const tokenProvider = new FakeTokenProvider();
      const reporter = new PrDecisionReporter({ ...h, tokenProvider });
      const decision = { kind, reason, detail: CANARY };
      await reporter.report({ ...query, decision });
      expect(tokenProvider.calls).toEqual([[query.owner, query.repo, "checks"]]);
      const call = h.http.calls[0]!;
      expect(call.url).toBe("https://api.github.com/repos/kaeawc/auto-mobile/check-runs");
      expect(call.init.method).toBe("POST");
      expect(call.init.headers.Authorization).toBe(`Bearer ${CANARY}`);
      const body = JSON.parse(call.init.body!);
      expect(body).toEqual({
        name: "attestation / tier-2",
        head_sha: query.sha,
        status: "completed",
        conclusion: kind === "skip" ? "success" : "neutral",
        output: {
          title: `${kind}: ${decisionReasonText[reason]}`,
          summary: `${kind}: ${decisionReasonText[reason]}`,
        },
      });
      expect(call.init.body).not.toContain(CANARY);
      expect(decision).toEqual({ kind, reason, detail: CANARY });
    });
  }

  test.each(["auth", "http", "network", "missing"])(
    "%s failure is warned, swallowed and leaves decision unchanged",
    async (failure) => {
      const h = harness();
      const tokens = new FakeTokenProvider();
      if (failure === "auth") {
        tokens.error = new Error(CANARY);
      }
      if (failure === "missing") {
        tokens.token = "";
      }
      h.http.queue.push(
        failure === "network" ? new Error(CANARY) : response({ secret: CANARY }, 500),
      );
      const decision = { kind: "ignore", reason: "no-attestation" } as const;
      await expect(
        new PrDecisionReporter({ ...h, tokenProvider: tokens }).report({ ...query, decision }),
      ).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalled();
      expect(JSON.stringify(warn.mock.calls)).not.toContain(CANARY);
      expect(decision).toEqual({ kind: "ignore", reason: "no-attestation" });
    },
  );

  test("report deadline swallows stalled request", async () => {
    const h = harness();
    h.http.handler = () => new Promise(() => {});
    const pending = new PrDecisionReporter({ ...h, tokenProvider: new FakeTokenProvider() }).report(
      { ...query, decision: { kind: "ignore", reason: "stale" } },
    );
    await flushMicrotasks();
    h.timer.advanceTime(10_000);
    await pending;
    expect(warn).toHaveBeenCalled();
    expect(h.http.calls[0]!.init.signal!.aborted).toBe(true);
  });
});
