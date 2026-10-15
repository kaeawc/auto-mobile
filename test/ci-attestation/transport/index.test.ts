import { expect, spyOn, test } from "bun:test";
import { inspect } from "node:util";
import {
  AttestationServiceClient,
  GitHubAppTokenProvider,
  NoopAttestationUploader,
  PrDecisionReporter,
  combineDecisions,
} from "../../../src/ci-attestation/transport";
import { logger } from "../../../src/utils/logger";
import { CANARY, HASH, harness, query, rawResponse, response, tokenResponse } from "./fakes";

test("barrel exposes local default and downgrade guard", async () => {
  expect(
    await new NoopAttestationUploader().upload({ inputHash: HASH, tier: 1, envelope: {} }),
  ).toEqual({ ok: false, reason: "uploads-disabled" });
  expect(
    combineDecisions(
      { kind: "ignore", reason: "unauthenticated" },
      { kind: "skip", reason: "verified-match" },
    ).kind,
  ).toBe("ignore");
});

test("provider and client inspection expose only class names after acquisition", async () => {
  const h = harness();
  const privateKey = "PRIVATE_KEY_INSPECTION_CANARY";
  // Use a plain config so the config's own redaction cannot mask a leak.
  h.config = { ...h.config, privateKey };
  h.http.queue.push(tokenResponse(h.clock), response({ kind: "skip", reason: "verified-match" }));
  const provider = new GitHubAppTokenProvider(h);
  const client = new AttestationServiceClient({
    ...h,
    tokenProvider: provider,
    owner: query.owner,
    repo: query.repo,
  });
  expect(await client.decide(query)).toEqual({ kind: "skip", reason: "verified-match" });
  expect(h.http.calls).toHaveLength(2);
  for (const [instance, name] of [
    [provider, "GitHubAppTokenProvider"],
    [client, "AttestationServiceClient"],
  ] as const) {
    expect(inspect(instance, { depth: 6 })).toBe(name);
    expect(JSON.stringify(instance)).toBe(JSON.stringify(name));
    for (const output of [
      inspect(instance, { depth: 6 }),
      JSON.stringify(instance),
      inspect(instance, { depth: 6, customInspect: false, showHidden: true }),
    ]) {
      expect(output).not.toContain(CANARY);
      expect(output).not.toContain(privateKey);
    }
  }
});

test("canary never escapes complete auth, upload, decision, reporting and failure flows", async () => {
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    const h = harness();
    const tokens = new GitHubAppTokenProvider(h);
    const client = new AttestationServiceClient({
      ...h,
      tokenProvider: tokens,
      owner: query.owner,
      repo: query.repo,
    });
    const reporter = new PrDecisionReporter({ ...h, tokenProvider: tokens });
    h.http.queue.push(
      tokenResponse(h.clock),
      response({ ok: true, id: CANARY }),
      response({ kind: "skip", reason: "verified-match", detail: CANARY }),
      tokenResponse(h.clock),
      response({ id: CANARY }),
    );
    const upload = await client.upload({
      inputHash: HASH,
      tier: 2,
      envelope: { signature: "opaque" },
    });
    const decision = await client.decide(query);
    await reporter.report({ ...query, decision });
    expect(decision.kind).toBe("skip");
    h.http.queue.push(rawResponse(CANARY), new Error(CANARY), response({ secret: CANARY }, 403));
    const invalid = await client.decide(query);
    const unavailable = await client.upload({ inputHash: HASH, tier: 2, envelope: {} });
    await reporter.report({ ...query, decision: invalid });
    h.signer.error = new Error(CANARY);
    const signingFailure = await new GitHubAppTokenProvider(h)
      .getInstallationToken("o", "r", "service")
      .catch((error: unknown) => String(error));
    h.signer.error = undefined;
    h.http.queue.push(response({ token: CANARY, expires_at: CANARY }));
    const malformed = await new GitHubAppTokenProvider(h)
      .getInstallationToken("o", "r", "service")
      .catch((error: unknown) => String(error));
    for (const output of [
      String(h.config),
      JSON.stringify(h.config),
      inspect(h.config),
      inspect(tokens, { depth: 6 }),
      JSON.stringify(tokens),
      inspect(client, { depth: 6 }),
      JSON.stringify(client),
      JSON.stringify({ upload, decision, invalid, unavailable }),
      JSON.stringify(warn.mock.calls),
      signingFailure,
      malformed,
    ]) {
      expect(output).not.toContain(CANARY);
    }
    expect(invalid.kind).toBe("ignore");
    expect(unavailable.ok).toBe(false);
    expect(signingFailure).toContain("unauthenticated");
    expect(malformed).toContain("invalid-response");
  } finally {
    warn.mockRestore();
  }
});
