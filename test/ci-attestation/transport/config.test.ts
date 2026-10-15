import { describe, expect, test } from "bun:test";
import { inspect } from "node:util";
import { loadTransportConfigFromEnv } from "../../../src/ci-attestation/transport/config";
import { CANARY, config, validEnv } from "./fakes";

describe("transport config", () => {
  test("all missing returns only required setting names", () => {
    expect(loadTransportConfigFromEnv({})).toEqual({
      ok: false,
      missing: [
        "AUTOMOBILE_ATTESTATION_APP_ID",
        "AUTOMOBILE_ATTESTATION_APP_PRIVATE_KEY",
        "AUTOMOBILE_ATTESTATION_SERVICE_URL",
      ],
    });
  });
  test("valid settings and optional installation lookup", () => {
    expect(config().githubApiUrl).toBe("https://api.github.com");
    expect(
      config({ ...validEnv, AUTOMOBILE_ATTESTATION_INSTALLATION_ID: undefined }).installationId,
    ).toBeUndefined();
    expect(config().appId).toBe("123");
  });
  test.each([
    "http://attestation.example.test",
    "https://user:secret@example.test",
    "https://example.test?q=secret",
    "https://example.test/#secret",
    "https://example.test?",
    "https://example.test/#",
    "invalid",
  ])("rejects unsafe service URL %s", (url) => {
    expect(
      loadTransportConfigFromEnv({ ...validEnv, AUTOMOBILE_ATTESTATION_SERVICE_URL: url }),
    ).toEqual({ ok: false, missing: ["AUTOMOBILE_ATTESTATION_SERVICE_URL"] });
  });
  test.each(["localhost", "127.0.0.1", "[::1]"])("localhost %s needs explicit flag", (host) => {
    const env = { ...validEnv, AUTOMOBILE_ATTESTATION_SERVICE_URL: `http://${host}:8080/base` };
    expect(loadTransportConfigFromEnv(env).ok).toBe(false);
    expect(
      loadTransportConfigFromEnv({ ...env, AUTOMOBILE_ATTESTATION_ALLOW_INSECURE_LOCALHOST: "1" })
        .ok,
    ).toBe(true);
    expect(
      loadTransportConfigFromEnv({
        ...validEnv,
        AUTOMOBILE_ATTESTATION_SERVICE_URL: "http://external.example.test",
        AUTOMOBILE_ATTESTATION_ALLOW_INSECURE_LOCALHOST: "1",
      }).ok,
    ).toBe(false);
  });
  test.each(["0", "-1", "abc", "1.5", "", "123\n"])("rejects invalid IDs %s", (id) => {
    expect(
      loadTransportConfigFromEnv({
        ...validEnv,
        AUTOMOBILE_ATTESTATION_APP_ID: id,
        AUTOMOBILE_ATTESTATION_INSTALLATION_ID: id,
      }),
    ).toEqual({
      ok: false,
      missing: ["AUTOMOBILE_ATTESTATION_APP_ID", "AUTOMOBILE_ATTESTATION_INSTALLATION_ID"],
    });
  });
  test("GitHub API requires HTTPS and a clean URL", () => {
    for (const url of [
      "http://localhost",
      "https://user:secret@example.test",
      "https://example.test/?q=x",
      "https://example.test?",
      "https://example.test/#",
    ]) {
      expect(loadTransportConfigFromEnv({ ...validEnv, GITHUB_API_URL: url })).toEqual({
        ok: false,
        missing: ["GITHUB_API_URL"],
      });
    }
  });
  test("unescapes PEM newlines and redacts all serializations", () => {
    const cfg = config({
      ...validEnv,
      AUTOMOBILE_ATTESTATION_APP_PRIVATE_KEY:
        validEnv.AUTOMOBILE_ATTESTATION_APP_PRIVATE_KEY.replaceAll("\n", "\\n"),
    });
    expect(cfg.privateKey).toBe(validEnv.AUTOMOBILE_ATTESTATION_APP_PRIVATE_KEY);
    expect(
      config({
        ...validEnv,
        AUTOMOBILE_ATTESTATION_APP_PRIVATE_KEY:
          validEnv.AUTOMOBILE_ATTESTATION_APP_PRIVATE_KEY.replaceAll("\n", "\r\n"),
      }).privateKey,
    ).toBe(validEnv.AUTOMOBILE_ATTESTATION_APP_PRIVATE_KEY);
    for (const serialized of [
      String(cfg),
      JSON.stringify(cfg),
      inspect(cfg),
      JSON.stringify({ ...cfg }),
    ]) {
      expect(serialized).not.toContain(CANARY);
    }
    expect(JSON.stringify(cfg)).toContain("[REDACTED]");
  });
});
