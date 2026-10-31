import { describe, expect, test } from "bun:test";
import { createPublicKey, verify } from "node:crypto";
import {
  INJECT_AUDIO_METHOD,
  STREAM_AUDIO_METHOD,
} from "../../../../src/utils/android-cmdline-tools/emulatorGrpc/EmulatorAudioClient";
import {
  GrpcStatus,
  type GrpcStatusResult,
} from "../../../../src/utils/android-cmdline-tools/emulatorGrpc/grpcFraming";
import path from "node:path";
import {
  createGrpcAuthorizer,
  JwtGrpcAuthorizer,
  type JwtKeyFs,
} from "../../../../src/utils/android-cmdline-tools/emulatorGrpc/emulatorGrpcAuth";
import { CountingIdGenerator } from "../../../../src/utils/CountingIdGenerator";
import { FakeTimer } from "../../../fakes/FakeTimer";

/** Where the authorizer writes its first key; built like the source does, so Windows separators match. */
const KEY_FILE = path.join("/jwks", "key-1.jwk");

/** An in-memory jwks dir; `acceptKeys` mimics the emulator loading new keys into its active set. */
function fakeJwksFs(acceptKeys: boolean): JwtKeyFs & { files: Map<string, string> } {
  const files = new Map<string, string>([["/jwks/active.jwk", JSON.stringify({ keys: [] })]]);
  return {
    files,
    writeFile: async (file, content) => {
      files.set(file, content);
      if (acceptKeys) {
        const added = (JSON.parse(content) as { keys: JsonWebKey[] }).keys;
        files.set("/jwks/active.jwk", JSON.stringify({ keys: added }));
      }
    },
    readFile: async (file) => {
      const content = files.get(file);
      if (content === undefined) {
        throw new Error(`ENOENT ${file}`);
      }
      return content;
    },
    unlink: async (file) => {
      files.delete(file);
    },
  };
}

/**
 * The emulator's JWT check as measured on emulator 37.1.11 (#16026): a token with a `typ` header
 * is refused before anything else, then the issuer must be one its default allowlist
 * (`lib/emulator_access.json`) lets call the method, and the signature must verify against a key
 * in its active set.
 */
function emulatorVerdict(
  authorization: string,
  method: string,
  activeKeys: JsonWebKey[],
): GrpcStatusResult {
  const [headerPart, payloadPart, signature] = authorization.replace(/^Bearer /, "").split(".");
  const header = decodeSegment(headerPart);
  if ("typ" in header) {
    return {
      code: GrpcStatus.INVALID_ARGUMENT,
      message: "invalid JWT; token has type header set, but validator not",
    };
  }
  const payload = decodeSegment(payloadPart);
  const audioIssuers = ["android-studio"];
  if (typeof payload.iss !== "string" || !audioIssuers.includes(payload.iss)) {
    return {
      code: GrpcStatus.PERMISSION_DENIED,
      message: `The endpoint: ${method} is not on the allowlist loaded from: emulator_access.json`,
    };
  }
  const key = activeKeys.find((candidate) => (candidate as { kid?: string }).kid === header.kid);
  const valid =
    key !== undefined &&
    Array.isArray(payload.aud) &&
    payload.aud.includes(method) &&
    verify(
      "sha512",
      Buffer.from(`${headerPart}.${payloadPart}`),
      { key: createPublicKey({ key, format: "jwk" }), dsaEncoding: "ieee-p1363" },
      Buffer.from(signature, "base64url"),
    );
  return valid
    ? { code: GrpcStatus.OK, message: "" }
    : { code: GrpcStatus.UNAUTHENTICATED, message: "signature" };
}

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown>;
}

describe("JwtGrpcAuthorizer", () => {
  test("registers a public JWK and signs an ES512 token scoped to the method", async () => {
    const fs = fakeJwksFs(true);
    const timer = new FakeTimer();
    timer.setCurrentTime(1_700_000_000_000);
    const authorizer = new JwtGrpcAuthorizer("/jwks", "/jwks/active.jwk", fs, {
      ids: new CountingIdGenerator("key"),
      timer,
    });

    const header = await authorizer.authorization(
      "/android.emulation.control.EmulatorController/injectAudio",
    );

    const jwkFile = fs.files.get(KEY_FILE);
    expect(jwkFile).toBeDefined();
    const [jwk] = (JSON.parse(jwkFile ?? "{}") as { keys: JsonWebKey[] }).keys;
    expect(jwk).toMatchObject({
      kty: "EC",
      crv: "P-521",
      alg: "ES512",
      kid: "key-1",
      key_ops: ["verify"],
    });
    expect(jwk.d).toBeUndefined();

    const [headerPart, payloadPart, signature] = header.replace(/^Bearer /, "").split(".");
    // No `typ`, and an issuer the emulator's default allowlist admits for audio (#16026).
    expect(decodeSegment(headerPart)).toEqual({ alg: "ES512", kid: "key-1" });
    expect(decodeSegment(payloadPart)).toEqual({
      iss: "android-studio",
      aud: ["/android.emulation.control.EmulatorController/injectAudio"],
      iat: 1_700_000_000,
      exp: 1_700_000_900,
    });
    const valid = verify(
      "sha512",
      Buffer.from(`${headerPart}.${payloadPart}`),
      { key: createPublicKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" },
      Buffer.from(signature, "base64url"),
    );
    expect(valid).toBe(true);

    await authorizer.dispose();
    expect(fs.files.has(KEY_FILE)).toBe(false);
    await authorizer.dispose();
  });

  test.each([INJECT_AUDIO_METHOD, STREAM_AUDIO_METHOD])(
    "a default -grpc-use-jwt emulator accepts the token for %s",
    async (method) => {
      const fs = fakeJwksFs(true);
      const authorizer = new JwtGrpcAuthorizer("/jwks", "/jwks/active.jwk", fs, {
        ids: new CountingIdGenerator("key"),
        timer: new FakeTimer(),
      });
      const authorization = await authorizer.authorization(method);
      const active = JSON.parse(fs.files.get("/jwks/active.jwk") ?? "{}") as {
        keys: JsonWebKey[];
      };
      expect(emulatorVerdict(authorization, method, active.keys)).toEqual({
        code: GrpcStatus.OK,
        message: "",
      });
      // Scoped to its method: the same token is not valid for the other audio RPC.
      const other = method === INJECT_AUDIO_METHOD ? STREAM_AUDIO_METHOD : INJECT_AUDIO_METHOD;
      expect(emulatorVerdict(authorization, other, active.keys).code).toBe(
        GrpcStatus.UNAUTHENTICATED,
      );
    },
  );

  test("fails with guidance and removes its key when the emulator never loads it", async () => {
    const fs = fakeJwksFs(false);
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const authorizer = new JwtGrpcAuthorizer("/jwks", "/jwks/active.jwk", fs, {
      ids: new CountingIdGenerator("key"),
      timer,
    });

    await expect(authorizer.authorization("/m")).rejects.toThrow(/-grpc-use-token/);
    expect(fs.files.has(KEY_FILE)).toBe(false);
    expect(timer.getSleepCallCount()).toBe(10);
  });
});

describe("createGrpcAuthorizer", () => {
  test("token auth sends the bearer token and no auth sends nothing", async () => {
    const fs = fakeJwksFs(true);
    expect(
      await createGrpcAuthorizer({ kind: "token", token: "t0k" }, fs).authorization("/m"),
    ).toBe("Bearer t0k");
    expect(await createGrpcAuthorizer({ kind: "none" }, fs).authorization("/m")).toBeUndefined();
  });
});
