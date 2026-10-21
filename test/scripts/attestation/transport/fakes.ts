import type { FetchLike } from "../../../../src/features/webrtc/WhipClient";
import type { JwtSigner } from "../../../../scripts/ci/attestation/transport/appAuth";
import { loadTransportConfigFromEnv } from "../../../../scripts/ci/attestation/transport/config";
import type {
  AttestationVerdict,
  ServiceDecisionReason,
  Clock,
  InstallationTokenProvider,
  InstallationTokenPurpose,
} from "../../../../scripts/ci/attestation/transport/types";
import { FakeTimer } from "../../../fakes/FakeTimer";

export const CANARY = "TRANSPORT_SECRET_CANARY";
export const HASH = "a".repeat(64);
export const query = {
  owner: "kaeawc",
  repo: "auto-mobile",
  sha: "b".repeat(40),
  tier: 2,
  inputHash: HASH,
};
export const validEnv = {
  AUTOMOBILE_ATTESTATION_APP_ID: "123",
  AUTOMOBILE_ATTESTATION_APP_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${CANARY}\n-----END PRIVATE KEY-----`,
  AUTOMOBILE_ATTESTATION_INSTALLATION_ID: "456",
  AUTOMOBILE_ATTESTATION_SERVICE_URL: "https://attestation.example.test",
};

export function config(env: Record<string, string | undefined> = validEnv) {
  const result = loadTransportConfigFromEnv(env);
  if (!result.ok) {
    throw new Error("Test configuration invalid");
  }
  return result.config;
}

export class FakeClock implements Clock {
  ms = 1_800_000_000_000;
  nowMs(): number {
    return this.ms;
  }
}

export class FakeJwtSigner implements JwtSigner {
  calls: { input: string; key: string }[] = [];
  error?: Error;
  sign(input: string, key: string): string {
    this.calls.push({ input, key });
    if (this.error) {
      throw this.error;
    }
    return CANARY;
  }
}

export class FakeTokenProvider implements InstallationTokenProvider {
  token = CANARY;
  error?: Error;
  calls: [string, string, InstallationTokenPurpose][] = [];
  getInstallationToken(
    owner: string,
    repo: string,
    purpose: InstallationTokenPurpose,
  ): Promise<string> {
    this.calls.push([owner, repo, purpose]);
    return this.error ? Promise.reject(this.error) : Promise.resolve(this.token);
  }
}

type HttpResponse = Awaited<ReturnType<FetchLike>>;
export function response(body: unknown, status = 200): HttpResponse {
  return rawResponse(JSON.stringify(body), status);
}

export function rawResponse(
  body: string,
  status = 200,
  length: string | null = null,
): HttpResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => length },
    text: () => Promise.resolve(body),
  };
}

export class HttpHarness {
  calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
  queue: (HttpResponse | Error)[] = [];
  handler?: FetchLike;
  readonly fetch: FetchLike = (url, init) => this.respond(url, init);
  respond(url: string, init: Parameters<FetchLike>[1]): Promise<HttpResponse> {
    this.calls.push({ url, init });
    if (this.handler) {
      return this.handler(url, init);
    }
    const next = this.queue.shift() ?? response({});
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  }
}

// Share the immutable, validated fixture instead of reparsing URLs in every test.
const defaultConfig = config();

export function harness() {
  const http = new HttpHarness();
  return {
    http,
    fetchImpl: http.fetch,
    timer: new FakeTimer(),
    clock: new FakeClock(),
    signer: new FakeJwtSigner(),
    config: defaultConfig,
  };
}

export function tokenResponse(clock: Clock, token = CANARY) {
  return response({ token, expires_at: new Date(clock.nowMs() + 3_600_000).toISOString() });
}

export async function flushMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 30; turn++) {
    await Promise.resolve();
  }
}

// Exhaustive expected protocol matrix, independent of the production validator.
export const expectedDecisionReasons: Record<AttestationVerdict, readonly ServiceDecisionReason[]> =
  {
    skip: ["verified-match"],
    advisory: [
      "policy-tier",
      "verified-match",
      "stale",
      "env-mismatch",
      "hash-mismatch",
      "no-attestation",
    ],
    ignore: [
      "verified-match",
      "no-attestation",
      "hash-mismatch",
      "stale",
      "env-mismatch",
      "policy-tier",
      "transport-unavailable",
      "invalid-response",
      "unauthenticated",
    ],
  };
