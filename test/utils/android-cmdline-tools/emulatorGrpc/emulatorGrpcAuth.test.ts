import { describe, expect, test } from "bun:test";
import { createPublicKey, verify } from "node:crypto";
import {
  createGrpcAuthorizer,
  JwtGrpcAuthorizer,
  type JwtKeyFs,
} from "../../../../src/utils/android-cmdline-tools/emulatorGrpc/emulatorGrpcAuth";
import { CountingIdGenerator } from "../../../../src/utils/CountingIdGenerator";
import { FakeTimer } from "../../../fakes/FakeTimer";

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

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown>;
}

describe("JwtGrpcAuthorizer", () => {
  test("registers a public JWK and signs an ES512 token scoped to the method", async () => {
    const fs = fakeJwksFs(true);
    const timer = new FakeTimer();
    timer.setCurrentTime(1_700_000_000_000);
    const authorizer = new JwtGrpcAuthorizer(
      "/jwks",
      "/jwks/active.jwk",
      fs,
      new CountingIdGenerator("key"),
      timer,
    );

    const header = await authorizer.authorization(
      "/android.emulation.control.EmulatorController/injectAudio",
    );

    const jwkFile = fs.files.get("/jwks/key-1.jwk");
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
    expect(decodeSegment(headerPart)).toEqual({ alg: "ES512", typ: "JWT", kid: "key-1" });
    expect(decodeSegment(payloadPart)).toEqual({
      iss: "AutoMobile",
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
    expect(fs.files.has("/jwks/key-1.jwk")).toBe(false);
    await authorizer.dispose();
  });

  test("fails with guidance and removes its key when the emulator never loads it", async () => {
    const fs = fakeJwksFs(false);
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const authorizer = new JwtGrpcAuthorizer(
      "/jwks",
      "/jwks/active.jwk",
      fs,
      new CountingIdGenerator("key"),
      timer,
    );

    await expect(authorizer.authorization("/m")).rejects.toThrow(/-grpc-use-token/);
    expect(fs.files.has("/jwks/key-1.jwk")).toBe(false);
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
