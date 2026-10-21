import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { AttestationServiceClient } from "../../../../scripts/ci/attestation/transport/serviceClient";
import { decisionReasons } from "../../../../scripts/ci/attestation/transport/types";
import { logger } from "../../../../src/utils/logger";
import {
  CANARY,
  expectedDecisionReasons,
  FakeTokenProvider,
  HASH,
  flushMicrotasks,
  harness,
  query,
  rawResponse,
  response,
} from "./fakes";

function serviceHarness() {
  const h = {
    ...harness(),
    tokenProvider: new FakeTokenProvider(),
    owner: query.owner,
    repo: query.repo,
  };
  return { ...h, client: new AttestationServiceClient(h) };
}

describe("attestation service transport", () => {
  let warn: ReturnType<typeof spyOn<typeof logger, "warn">>;
  beforeEach(() => {
    warn = spyOn(logger, "warn").mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  for (const kind of ["skip", "advisory"] as const) {
    test.each(decisionReasons.filter((reason) => !expectedDecisionReasons[kind].includes(reason)))(
      `rejects disallowed ${kind} / %s as invalid-response`,
      async (reason) => {
        const h = serviceHarness();
        h.http.queue.push(response({ kind, reason }));
        expect(await h.client.decide(query)).toEqual({
          kind: "ignore",
          reason: "invalid-response",
        });
      },
    );
  }

  test("uploads opaque envelope to the hash path with scoped bearer token", async () => {
    const h = serviceHarness();
    h.http.queue.push(response({ ok: true, id: "opaque-id" }));
    const envelope = { signature: "opaque", payload: { data: true } };
    expect(await h.client.upload({ inputHash: HASH, tier: 2, envelope })).toEqual({ ok: true });
    expect(h.tokenProvider.calls).toEqual([[query.owner, query.repo, "service"]]);
    expect(h.http.calls[0]!.url).toBe(`https://attestation.example.test/v1/attestations/${HASH}`);
    expect(h.http.calls[0]!.init.method).toBe("PUT");
    expect(JSON.parse(h.http.calls[0]!.init.body!)).toEqual({ tier: 2, envelope });
    expect(h.http.calls[0]!.init.headers.Authorization).toBe(`Bearer ${CANARY}`);
  });

  test.each(["skip", "advisory", "ignore"] as const)(
    "accepts valid authoritative %s decision",
    async (kind) => {
      const h = serviceHarness();
      h.http.queue.push(response({ kind, reason: "verified-match", detail: CANARY }));
      expect(await h.client.decide(query)).toEqual({ kind, reason: "verified-match" });
      expect(h.http.calls[0]!.url).toBe("https://attestation.example.test/v1/decisions");
      expect(h.http.calls[0]!.init.method).toBe("POST");
      expect(JSON.parse(h.http.calls[0]!.init.body!)).toEqual(query);
      expect(h.http.calls[0]!.init.headers.Authorization).toBe(`Bearer ${CANARY}`);
    },
  );

  test.each([401, 403, 429, 500, 302])("HTTP %s never grants or throws", async (status) => {
    const h = serviceHarness();
    h.http.queue.push(response({ kind: "skip", reason: "verified-match", secret: CANARY }, status));
    expect(await h.client.decide(query)).toEqual({
      kind: "ignore",
      reason: status === 401 || status === 403 ? "unauthenticated" : "transport-unavailable",
    });
    expect(h.http.calls).toHaveLength(1);
  });

  test.each(
    [
      null,
      {},
      { kind: "grant", reason: "verified-match" },
      { kind: "skip", reason: "unknown" },
      { kind: "skip", reason: "verified-match", detail: 42 },
      [],
    ].map((body) => ({ body })),
  )("invalid response %j forces a real run", async ({ body }) => {
    const h = serviceHarness();
    h.http.queue.push(response(body));
    expect(await h.client.decide(query)).toEqual({ kind: "ignore", reason: "invalid-response" });
  });

  test.each(["../path", "A".repeat(64), "a".repeat(63), `${HASH}?x=1`, `${HASH}\n`])(
    "invalid hash %s is rejected before auth or fetch",
    async (inputHash) => {
      const h = serviceHarness();
      expect(await h.client.decide({ ...query, inputHash })).toEqual({
        kind: "ignore",
        reason: "invalid-response",
      });
      expect(await h.client.upload({ inputHash, tier: 2, envelope: {} })).toEqual({
        ok: false,
        reason: "invalid-response",
      });
      expect(h.tokenProvider.calls).toHaveLength(0);
      expect(h.http.calls).toHaveLength(0);
    },
  );

  test.each([
    rawResponse(CANARY),
    rawResponse("x".repeat(65_537)),
    rawResponse("é".repeat(33_000)),
    rawResponse("{}", 200, "65537"),
  ])("bad JSON and oversize responses force real runs", async (body) => {
    const h = serviceHarness();
    h.http.queue.push(body);
    expect(await h.client.decide(query)).toEqual({ kind: "ignore", reason: "invalid-response" });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(CANARY);
  });

  test("network error is sanitized and upload also never throws", async () => {
    const h = serviceHarness();
    h.http.queue.push(new Error(CANARY), new Error(CANARY));
    expect(await h.client.decide(query)).toEqual({
      kind: "ignore",
      reason: "transport-unavailable",
    });
    expect(await h.client.upload({ inputHash: HASH, tier: 2, envelope: {} })).toEqual({
      ok: false,
      reason: "transport-unavailable",
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(CANARY);
  });

  test("absent, empty and failed credentials never reach the service", async () => {
    const h = serviceHarness();
    h.tokenProvider.token = "";
    expect(await h.client.decide(query)).toEqual({ kind: "ignore", reason: "unauthenticated" });
    h.tokenProvider.error = new Error(CANARY);
    expect(await h.client.decide(query)).toEqual({ kind: "ignore", reason: "unauthenticated" });
    const missing = new AttestationServiceClient({ ...h, tokenProvider: undefined });
    expect(await missing.decide(query)).toEqual({ kind: "ignore", reason: "unauthenticated" });
    expect(h.http.calls).toHaveLength(0);
  });

  test.each(["fetch", "body", "token"])("deadline includes stalled %s", async (stage) => {
    const h = serviceHarness();
    if (stage === "token") {
      h.tokenProvider.getInstallationToken = () => new Promise(() => {});
    } else {
      h.http.handler = () =>
        stage === "fetch"
          ? new Promise(() => {})
          : Promise.resolve({ ...response({}), text: () => new Promise(() => {}) });
    }
    const pending = h.client.decide(query);
    await flushMicrotasks();
    h.timer.advanceTime(10_000);
    expect(await pending).toEqual({ kind: "ignore", reason: "transport-unavailable" });
    if (stage !== "token") {
      expect(h.http.calls[0]!.init.signal!.aborted).toBe(true);
    }
  });

  test.each([{}, { ok: false }, { ok: true, id: 12 }])(
    "invalid upload acknowledgement %j is typed failure",
    async (body) => {
      const h = serviceHarness();
      h.http.queue.push(response(body));
      expect(await h.client.upload({ inputHash: HASH, tier: 2, envelope: {} })).toEqual({
        ok: false,
        reason: "invalid-response",
      });
    },
  );

  test("non-JSON envelope fails safely before fetch", async () => {
    const h = serviceHarness();
    expect(await h.client.upload({ inputHash: HASH, tier: 2, envelope: 1n })).toEqual({
      ok: false,
      reason: "transport-unavailable",
    });
    expect(h.http.calls).toHaveLength(0);
  });
});
