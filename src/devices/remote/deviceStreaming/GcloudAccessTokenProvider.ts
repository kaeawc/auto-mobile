/**
 * {@link AccessTokenProvider} backed by the gcloud CLI (#14468). `gcloud auth print-access-token`
 * prints a token for the active account carrying the `cloud-platform` scope, refreshing it when it
 * is near expiry, so AutoMobile neither stores credentials nor adds a Google auth dependency.
 */
import { ActionableError, toActionableError } from "../../../models/ActionableError";
import type { HostCommandExecutor } from "../../../utils/HostCommandExecutor";
import type { Timer } from "../../../utils/SystemTimer";
import type { AccessTokenProvider } from "./DeviceStreamingApi";

/** gcloud issues one-hour tokens; reuse one well before that so a request never carries a stale one. */
export const GCLOUD_TOKEN_REUSE_MS = 45 * 60_000;
const GCLOUD_TIMEOUT_MS = 30_000;

export interface GcloudAccessTokenProviderOptions {
  host: HostCommandExecutor;
  timer: Pick<Timer, "now">;
  /** gcloud executable; defaults to `gcloud` on PATH. */
  gcloudPath?: string;
  reuseMs?: number;
}

export class GcloudAccessTokenProvider implements AccessTokenProvider {
  private cached?: { token: string; fetchedAtMs: number };
  private inFlight?: Promise<string>;

  constructor(private readonly options: GcloudAccessTokenProviderOptions) {}

  accessToken(): Promise<string> {
    const reuseMs = this.options.reuseMs ?? GCLOUD_TOKEN_REUSE_MS;
    if (this.cached && this.options.timer.now() - this.cached.fetchedAtMs < reuseMs) {
      return Promise.resolve(this.cached.token);
    }
    this.inFlight ??= this.fetchToken().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async fetchToken(): Promise<string> {
    const gcloud = this.options.gcloudPath ?? "gcloud";
    let stdout: string;
    try {
      const result = await this.options.host.executeCommand(
        gcloud,
        ["auth", "print-access-token"],
        { timeoutMs: GCLOUD_TIMEOUT_MS },
      );
      stdout = result.stdout;
    } catch (error) {
      throw toActionableError(
        error,
        "Could not get a Google Cloud access token; install the Google Cloud CLI and run " +
          "`gcloud auth login`",
      );
    }
    const token = stdout.trim();
    if (token.length === 0 || /\s/.test(token)) {
      throw new ActionableError(
        "`gcloud auth print-access-token` did not print a single access token. Run `gcloud auth login`.",
      );
    }
    this.cached = { token, fetchedAtMs: this.options.timer.now() };
    return token;
  }
}
