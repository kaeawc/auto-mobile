import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { generateKeyPairSync, verify, type KeyObject } from "node:crypto";
import {
  GitHubAppTokenProvider,
  RsaJwtSigner,
  TransportHttpClient,
} from "../../../../scripts/ci/attestation/transport/appAuth";
import { ActionableError } from "../../../../src/models";
import { logger } from "../../../../src/utils/logger";
import {
  CANARY,
  config,
  flushMicrotasks,
  harness,
  rawResponse,
  response,
  tokenResponse,
  validEnv,
} from "./fakes";

describe("GitHub App authentication", () => {
  let warn: ReturnType<typeof spyOn<typeof logger, "warn">>;
  beforeEach(() => {
    warn = spyOn(logger, "warn").mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  test.each(["service", "checks"] as const)(
    "JWT claims and %s token request restrict repository and permissions",
    async (purpose) => {
      const h = harness();
      h.http.queue.push(tokenResponse(h.clock));
      expect(
        await new GitHubAppTokenProvider(h).getInstallationToken("kaeawc", "auto-mobile", purpose),
      ).toBe(CANARY);
      const [header, claims] = h.signer.calls[0]!.input.split(".").map((part) =>
        JSON.parse(Buffer.from(part, "base64url").toString()),
      );
      expect(header).toEqual({ alg: "RS256", typ: "JWT" });
      expect(claims).toEqual({
        iat: h.clock.ms / 1000 - 60,
        exp: h.clock.ms / 1000 + 540,
        iss: "123",
      });
      const { url, init } = h.http.calls[0]!;
      expect(url).toBe("https://api.github.com/app/installations/456/access_tokens");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body!)).toEqual({
        permissions:
          purpose === "checks" ? { metadata: "read", checks: "write" } : { metadata: "read" },
        repositories: ["auto-mobile"],
      });
      expect(init.headers.Authorization).toBe(`Bearer ${h.signer.calls[0]!.input}.${CANARY}`);
      expect(init.headers.Accept).toBe("application/vnd.github+json");
      expect(init.headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
      expect(init.headers["User-Agent"]).toBeTruthy();
      expect(init.signal).toBeInstanceOf(AbortSignal);
    },
  );

  let pem: string;
  let publicKey: KeyObject;
  beforeAll(() => {
    // 512 bits is only a fast unit fixture, never an App production key.
    const keys = generateKeyPairSync("rsa", { modulusLength: 512 });
    publicKey = keys.publicKey;
    pem = keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  });

  test("RSA signer signs a throwaway small test key", () => {
    const signature = new RsaJwtSigner().sign("header.claims", pem);
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from("header.claims"),
        publicKey,
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true);
  });

  test("caches until exactly five minutes before expiry", async () => {
    const h = harness();
    const provider = new GitHubAppTokenProvider(h);
    h.http.queue.push(tokenResponse(h.clock, "first"));
    await provider.getInstallationToken("owner", "repo", "service");
    h.clock.ms += 3_299_999;
    expect(await provider.getInstallationToken("owner", "repo", "service")).toBe("first");
    h.clock.ms += 1;
    h.http.queue.push(tokenResponse(h.clock, "second"));
    expect(await provider.getInstallationToken("owner", "repo", "service")).toBe("second");
    expect(h.http.calls).toHaveLength(2);
  });

  test("coalesces concurrent requests but never shares tokens across repositories", async () => {
    const h = harness();
    h.http.queue.push(tokenResponse(h.clock), tokenResponse(h.clock));
    const provider = new GitHubAppTokenProvider(h);
    await Promise.all([
      provider.getInstallationToken("owner", "a", "service"),
      provider.getInstallationToken("owner", "a", "service"),
    ]);
    expect(h.http.calls).toHaveLength(1);
    await provider.getInstallationToken("owner", "b", "service");
    expect(h.http.calls).toHaveLength(2);
  });

  test("owner and purpose isolate cached and concurrent acquisitions", async () => {
    const h = harness();
    h.http.queue.push(
      tokenResponse(h.clock, "service-token"),
      tokenResponse(h.clock, "checks-token"),
      tokenResponse(h.clock, "other-owner-token"),
    );
    const provider = new GitHubAppTokenProvider(h);
    expect(
      await Promise.all([
        provider.getInstallationToken("owner", "repo", "service"),
        provider.getInstallationToken("owner", "repo", "checks"),
        provider.getInstallationToken("owner", "repo", "checks"),
      ]),
    ).toEqual(["service-token", "checks-token", "checks-token"]);
    expect(await provider.getInstallationToken("owner", "repo", "service")).toBe("service-token");
    expect(await provider.getInstallationToken("owner", "repo", "checks")).toBe("checks-token");
    expect(await provider.getInstallationToken("other", "repo", "service")).toBe(
      "other-owner-token",
    );
    expect(h.http.calls).toHaveLength(3);
    expect(h.http.calls.map(({ init }) => JSON.parse(init.body!).permissions)).toEqual([
      { metadata: "read" },
      { metadata: "read", checks: "write" },
      { metadata: "read" },
    ]);
  });

  test("declared oversize response is rejected without calling text", async () => {
    const h = harness();
    let read = false;
    h.http.queue.push({
      ...rawResponse("{}", 200, "65537"),
      text: async () => {
        read = true;
        return "{}";
      },
    });
    await expect(
      new TransportHttpClient(h).request("https://example.test", { method: "GET", headers: {} }),
    ).rejects.toThrow("invalid-response");
    expect(read).toBe(false);
  });

  test("clock failures during cached-token validation are sanitized", async () => {
    const h = harness();
    h.http.queue.push(tokenResponse(h.clock));
    const provider = new GitHubAppTokenProvider(h);
    await provider.getInstallationToken("o", "r", "service");
    h.clock.nowMs = () => {
      throw new Error(CANARY);
    };
    await expect(provider.getInstallationToken("o", "r", "service")).rejects.toThrow(
      "unauthenticated",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(CANARY);
  });

  test.each([
    {},
    { token: "x", expires_at: "bad" },
    { token: "", expires_at: "2099-01-01" },
    { token: "x", expires_at: "2000-01-01" },
  ])("malformed token is sanitized and not cached: %j", async (body) => {
    const h = harness();
    const provider = new GitHubAppTokenProvider(h);
    h.http.queue.push(response({ ...body, secret: CANARY }), tokenResponse(h.clock));
    await expect(provider.getInstallationToken("o", "r", "service")).rejects.toBeInstanceOf(
      ActionableError,
    );
    expect(await provider.getInstallationToken("o", "r", "service")).toBe(CANARY);
    expect(h.http.calls).toHaveLength(2);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(CANARY);
  });

  test("resolves absent installation ID with App JWT", async () => {
    const h = harness();
    h.config = config({ ...validEnv, AUTOMOBILE_ATTESTATION_INSTALLATION_ID: undefined });
    h.http.queue.push(response({ id: 789 }), tokenResponse(h.clock));
    await new GitHubAppTokenProvider(h).getInstallationToken("kaeawc", "auto-mobile", "service");
    expect(h.http.calls[0]!.url).toBe(
      "https://api.github.com/repos/kaeawc/auto-mobile/installation",
    );
    expect(h.http.calls[0]!.init.method).toBe("GET");
    expect(h.http.calls[0]!.init.headers.Authorization).toContain(`.${CANARY}`);
    expect(h.http.calls[1]!.url).toContain("/installations/789/");
  });

  test.each([429, 500, "network"])(
    "retries %s exactly once via bounded injected backoff",
    async (failure) => {
      const h = harness();
      h.http.queue.push(
        failure === "network" ? new Error(CANARY) : response({}, Number(failure)),
        tokenResponse(h.clock),
      );
      const pending = new GitHubAppTokenProvider({
        ...h,
        backoff: { delayForAttempt: () => 99999 },
      }).getInstallationToken("o", "r", "service");
      await flushMicrotasks();
      expect(h.http.calls).toHaveLength(1);
      h.timer.advanceTime(1000);
      expect(await pending).toBe(CANARY);
      expect(h.http.calls).toHaveLength(2);
    },
  );

  test("retry exhaustion does not cache failure or expose exception text", async () => {
    const h = harness();
    h.http.queue.push(new Error(CANARY), new Error(CANARY), tokenResponse(h.clock));
    const provider = new GitHubAppTokenProvider(h);
    const result = provider
      .getInstallationToken("o", "r", "service")
      .catch((error: unknown) => error);
    await flushMicrotasks();
    h.timer.advanceTime(100);
    expect(String(await result)).not.toContain(CANARY);
    expect(h.http.calls).toHaveLength(2);
    expect(await provider.getInstallationToken("o", "r", "service")).toBe(CANARY);
  });

  test("deadline aborts a hung request and does not retry timeout", async () => {
    const h = harness();
    h.http.handler = () => new Promise(() => {});
    const pending = new GitHubAppTokenProvider(h)
      .getInstallationToken("o", "r", "service")
      .catch((error: unknown) => error);
    h.timer.advanceTime(10_000);
    expect(await pending).toBeInstanceOf(ActionableError);
    expect(h.http.calls[0]!.init.signal!.aborted).toBe(true);
    expect(h.http.calls).toHaveLength(1);
  });

  test("body read is bounded and malformed JSON is never echoed", async () => {
    const h = harness();
    h.http.queue.push(rawResponse(CANARY));
    await expect(
      new GitHubAppTokenProvider(h).getInstallationToken("o", "r", "service"),
    ).rejects.toThrow("invalid-response");
    expect(JSON.stringify(warn.mock.calls)).not.toContain(CANARY);
  });
});
