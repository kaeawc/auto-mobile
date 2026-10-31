import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import path from "node:path";
import { ActionableError } from "../../../models/ActionableError";
import { errorMessage } from "../../../models/describeUnknownError";
import type { FileSystem } from "../../filesystem/DefaultFileSystem";
import { defaultIdGenerator, type IdGenerator } from "../../IdGenerator";
import { logger } from "../../logger";
import { defaultTimer, type Timer } from "../../SystemTimer";
import type { EmulatorGrpcAuth } from "./emulatorGrpcDiscovery";

/** Produces the `authorization` header value for one gRPC method call. */
export interface GrpcAuthorizer {
  authorization(method: string): Promise<string | undefined>;
  /** Removes anything the authorizer registered with the emulator. Idempotent. */
  dispose(): Promise<void>;
}

/**
 * The emulator's default allowlist (`lib/emulator_access.json`) only admits the issuers
 * `android-studio`, `icebox` and `gradle-utp-emulator-control`, and only `android-studio` may call
 * the audio RPCs. Any other issuer is refused with PERMISSION_DENIED even with a valid signature.
 */
export const JWT_ISSUER = "android-studio";
const JWT_LIFETIME_SECONDS = 15 * 60;
const KEY_ACCEPT_POLLS = 10;
const KEY_ACCEPT_POLL_MS = 100;

function base64Url(bytes: Uint8Array | string): string {
  return Buffer.from(bytes).toString("base64url");
}

export type JwtKeyFs = Pick<FileSystem, "writeFile" | "readFile" | "unlink">;

/**
 * JWT auth as the emulator expects it: the client drops a public JWK into the emulator's `jwks`
 * directory, waits until the emulator lists it in its active key set, then signs a short-lived
 * ES512 token per call with the method path as audience.
 */
export class JwtGrpcAuthorizer implements GrpcAuthorizer {
  private registration: Promise<{ kid: string; privateKey: KeyObject }> | undefined;
  private keyFile: string | undefined;

  private readonly ids: IdGenerator;
  private readonly timer: Pick<Timer, "now" | "sleep">;

  constructor(
    private readonly jwksDir: string,
    private readonly activeJwksFile: string,
    private readonly fs: JwtKeyFs,
    {
      ids = defaultIdGenerator,
      timer = defaultTimer,
    }: { ids?: IdGenerator; timer?: Pick<Timer, "now" | "sleep"> } = {},
  ) {
    this.ids = ids;
    this.timer = timer;
  }

  async authorization(method: string): Promise<string> {
    this.registration ??= this.register();
    const { kid, privateKey } = await this.registration;
    const issuedAt = Math.floor(this.timer.now() / 1000);
    // No `typ`: the emulator's validator refuses any token that sets it (INVALID_ARGUMENT).
    const header = base64Url(JSON.stringify({ alg: "ES512", kid }));
    const payload = base64Url(
      JSON.stringify({
        iss: JWT_ISSUER,
        aud: [method],
        iat: issuedAt,
        exp: issuedAt + JWT_LIFETIME_SECONDS,
      }),
    );
    const signature = sign("sha512", Buffer.from(`${header}.${payload}`), {
      key: privateKey,
      dsaEncoding: "ieee-p1363",
    });
    return `Bearer ${header}.${payload}.${base64Url(signature)}`;
  }

  async dispose(): Promise<void> {
    const keyFile = this.keyFile;
    this.keyFile = undefined;
    this.registration = undefined;
    if (!keyFile) {
      return;
    }
    try {
      await this.fs.unlink(keyFile);
    } catch (error) {
      // The emulator deletes its jwks directory on exit, taking the key with it.
      logger.debug(`emulator JWK ${keyFile} already gone: ${errorMessage(error)}`);
    }
  }

  private async register(): Promise<{ kid: string; privateKey: KeyObject }> {
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-521" });
    const kid = this.ids.next();
    const jwk = {
      ...publicKey.export({ format: "jwk" }),
      use: "sig",
      alg: "ES512",
      key_ops: ["verify"],
      kid,
    };
    this.keyFile = path.join(this.jwksDir, `${kid}.jwk`);
    await this.fs.writeFile(this.keyFile, JSON.stringify({ keys: [jwk] }));
    for (let poll = 0; poll < KEY_ACCEPT_POLLS; poll++) {
      if (await this.activeSetHas(kid)) {
        return { kid, privateKey };
      }
      await this.timer.sleep(KEY_ACCEPT_POLL_MS);
    }
    await this.dispose();
    throw new ActionableError(
      `The emulator did not load AutoMobile's gRPC key from ${this.jwksDir} within ` +
        `${KEY_ACCEPT_POLLS * KEY_ACCEPT_POLL_MS}ms. Restart the emulator, or launch it with -grpc-use-token.`,
    );
  }

  private async activeSetHas(kid: string): Promise<boolean> {
    try {
      const active = JSON.parse(await this.fs.readFile(this.activeJwksFile)) as {
        keys?: Array<{ kid?: string }>;
      };
      return active.keys?.some((key) => key.kid === kid) ?? false;
    } catch (error) {
      // The emulator rewrites the file as it loads keys; a partial read is retried on the next poll.
      logger.debug(`emulator active JWKS not readable yet: ${errorMessage(error)}`);
      return false;
    }
  }
}

export function createGrpcAuthorizer(auth: EmulatorGrpcAuth, fs: JwtKeyFs): GrpcAuthorizer {
  switch (auth.kind) {
    case "token":
      return { authorization: async () => `Bearer ${auth.token}`, dispose: async () => {} };
    case "jwt":
      return new JwtGrpcAuthorizer(auth.jwksDir, auth.activeJwksFile, fs);
    case "none":
      return { authorization: async () => undefined, dispose: async () => {} };
  }
}
