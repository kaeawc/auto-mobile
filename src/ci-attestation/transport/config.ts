import { inspect } from "node:util";
import { logger } from "../../utils/logger";

export interface TransportConfig {
  readonly appId: string;
  readonly privateKey: string;
  readonly installationId?: string;
  readonly serviceUrl: string;
  readonly githubApiUrl: string;
}

class RedactedTransportConfig implements TransportConfig {
  readonly #privateKey: string;

  constructor(
    readonly appId: string,
    privateKey: string,
    readonly installationId: string | undefined,
    readonly serviceUrl: string,
    readonly githubApiUrl: string,
  ) {
    this.#privateKey = privateKey;
  }

  get privateKey(): string {
    return this.#privateKey;
  }

  toJSON(): Record<string, string | undefined> {
    return {
      appId: this.appId,
      privateKey: "[REDACTED]",
      installationId: this.installationId,
      serviceUrl: this.serviceUrl,
      githubApiUrl: this.githubApiUrl,
    };
  }

  toString(): string {
    return JSON.stringify(this.toJSON());
  }

  [inspect.custom](): Record<string, string | undefined> {
    return this.toJSON();
  }
}

export type TransportConfigResult =
  | { ok: true; config: TransportConfig }
  | { ok: false; missing: string[] };

function validUrl(raw: string | undefined, allowLocalhost: boolean): string | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    const url = new URL(raw);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    const secure =
      url.protocol === "https:" || (allowLocalhost && local && url.protocol === "http:");
    if (
      !secure ||
      url.username ||
      url.password ||
      url.href.includes("?") ||
      url.href.includes("#")
    ) {
      return undefined;
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    logger.warn("Attestation configuration URL is invalid; transport disabled.");
    return undefined;
  }
}

function numericId(value: string | undefined): value is string {
  return value !== undefined && /^[1-9][0-9]*$/.test(value) && value.trim() === value;
}

/** Missing and invalid settings are reported by name only, never by value. */
export function loadTransportConfigFromEnv(
  env: Record<string, string | undefined>,
): TransportConfigResult {
  const prefix = "AUTOMOBILE_ATTESTATION_";
  const appId = env[`${prefix}APP_ID`];
  const privateKey = env[`${prefix}APP_PRIVATE_KEY`]
    ?.replaceAll("\\n", "\n")
    .replaceAll("\r\n", "\n");
  const installationId = env[`${prefix}INSTALLATION_ID`];
  const serviceUrl = validUrl(
    env[`${prefix}SERVICE_URL`],
    env[`${prefix}ALLOW_INSECURE_LOCALHOST`] === "1",
  );
  const githubApiUrl = validUrl(env.GITHUB_API_URL ?? "https://api.github.com", false);
  const missing: string[] = [];
  if (!numericId(appId)) {
    missing.push(`${prefix}APP_ID`);
  }
  if (
    !privateKey?.match(
      /^-----BEGIN (?:RSA )?PRIVATE KEY-----\n[\s\S]+\n-----END (?:RSA )?PRIVATE KEY-----\s*$/,
    )
  ) {
    missing.push(`${prefix}APP_PRIVATE_KEY`);
  }
  if (installationId !== undefined && !numericId(installationId)) {
    missing.push(`${prefix}INSTALLATION_ID`);
  }
  if (!serviceUrl) {
    missing.push(`${prefix}SERVICE_URL`);
  }
  if (!githubApiUrl) {
    missing.push("GITHUB_API_URL");
  }
  if (missing.length) {
    return { ok: false, missing };
  }
  // Every absent/invalid value above contributes its setting name to missing.
  return {
    ok: true,
    config: new RedactedTransportConfig(
      appId!,
      privateKey!,
      installationId,
      serviceUrl!,
      githubApiUrl!,
    ),
  };
}
