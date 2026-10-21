/**
 * REST client for the DDP Device Streaming API's `projects.deviceSessions` resource (#14054).
 * Reference: https://docs.cloud.google.com/device-streaming/docs/reference/rest/v1/projects.deviceSessions
 * The adb connection itself is a gRPC stream (`DirectAccessService.AdbConnect`) with no REST
 * transport, so it is not part of this client.
 */
import { z } from "zod";
import { ActionableError } from "../../../models/ActionableError";
import { errorMessage } from "../../../models/describeUnknownError";
import { logger } from "../../../utils/logger";
import { DeviceStreamingApiError } from "./DeviceStreamingApiError";
import type { Timer } from "../../../utils/SystemTimer";
import type { RemoteDeviceSession, RemoteDeviceSessionState } from "../remoteDeviceProvider";

export const DEVICE_STREAMING_ENDPOINT = "https://devicestreaming.googleapis.com/v1";
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export type DeviceStreamingFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Supplies an OAuth access token carrying the `https://www.googleapis.com/auth/cloud-platform` scope. */
export interface AccessTokenProvider {
  accessToken(): Promise<string>;
}

export interface CreateDeviceSessionRequest {
  /** Google Cloud project id that is billed for the session. */
  projectId: string;
  /** Final component of the resource name, 4-63 characters. Reusing it makes a retry safe. */
  sessionId: string;
  modelId: string;
  osVersionId: string;
  ttlMinutes: number;
  locale?: string;
  orientation?: string;
}

export interface DeviceStreamingApi {
  create(request: CreateDeviceSessionRequest): Promise<RemoteDeviceSession>;
  get(name: string): Promise<RemoteDeviceSession>;
  setExpireTime(name: string, expireTimeMs: number): Promise<RemoteDeviceSession>;
  cancel(name: string): Promise<void>;
}

const sessionStateSchema = z.object({ stateMessage: z.string().optional() });

const deviceSessionSchema = z.object({
  name: z.string(),
  state: z.string().optional(),
  stateHistories: z.array(sessionStateSchema).optional(),
  activeStartTime: z.string().optional(),
  expireTime: z.string().optional(),
});

const errorBodySchema = z.object({
  error: z.object({ message: z.string().optional(), status: z.string().optional() }),
});

const STATE_MAP: Readonly<Record<string, RemoteDeviceSessionState>> = {
  REQUESTED: "requested",
  PENDING: "pending",
  ACTIVE: "active",
  FINISHED: "finished",
  EXPIRED: "expired",
  UNAVAILABLE: "unavailable",
  ERROR: "error",
};

function timestampMs(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/** Maps a `DeviceSession` JSON body. Unrecognized states map to `unknown`, which is not terminal. */
export function parseDeviceSession(body: unknown): RemoteDeviceSession {
  const parsed = deviceSessionSchema.safeParse(body);
  if (!parsed.success) {
    throw new ActionableError(`Device Streaming returned an unexpected session: ${parsed.error}`);
  }
  const session = parsed.data;
  return {
    id: session.name,
    state: STATE_MAP[session.state ?? ""] ?? "unknown",
    stateMessage: session.stateHistories?.at(-1)?.stateMessage,
    activeStartTimeMs: timestampMs(session.activeStartTime),
    expireTimeMs: timestampMs(session.expireTime),
  };
}

export interface RestDeviceStreamingApiOptions {
  tokens: AccessTokenProvider;
  timer: Pick<Timer, "setTimeout" | "clearTimeout">;
  fetch?: DeviceStreamingFetch;
  endpoint?: string;
  requestTimeoutMs?: number;
}

export class RestDeviceStreamingApi implements DeviceStreamingApi {
  private readonly fetch: DeviceStreamingFetch;
  private readonly endpoint: string;
  private readonly requestTimeoutMs: number;

  constructor(private readonly options: RestDeviceStreamingApiOptions) {
    this.fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.endpoint = options.endpoint ?? DEVICE_STREAMING_ENDPOINT;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  async create(request: CreateDeviceSessionRequest): Promise<RemoteDeviceSession> {
    const query = new URLSearchParams({ deviceSessionId: request.sessionId });
    const body = {
      ttl: `${request.ttlMinutes * 60}s`,
      androidDevice: {
        androidModelId: request.modelId,
        androidVersionId: request.osVersionId,
        locale: request.locale,
        orientation: request.orientation,
      },
    };
    const path = `projects/${encodeURIComponent(request.projectId)}/deviceSessions?${query}`;
    return parseDeviceSession(await this.send("POST", path, body));
  }

  async get(name: string): Promise<RemoteDeviceSession> {
    return parseDeviceSession(await this.send("GET", name));
  }

  /**
   * The reference says a session's allocation is extendable through `patch` but does not list the
   * patchable fields. `expireTime` is used because it is absolute, so a retried patch is harmless.
   */
  async setExpireTime(name: string, expireTimeMs: number): Promise<RemoteDeviceSession> {
    const query = new URLSearchParams({ updateMask: "expireTime" });
    const body = { expireTime: new Date(expireTimeMs).toISOString() };
    return parseDeviceSession(await this.send("PATCH", `${name}?${query}`, body));
  }

  async cancel(name: string): Promise<void> {
    await this.send("POST", `${name}:cancel`, {});
  }

  private async send(method: string, path: string, body?: unknown): Promise<unknown> {
    const token = await this.options.tokens.accessToken();
    const controller = new AbortController();
    const handle = this.options.timer.setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await this.fetch(`${this.endpoint}/${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const json = parseBody(await response.text());
      if (!response.ok) {
        throw apiError(method, path, response.status, json);
      }
      return json;
    } finally {
      this.options.timer.clearTimeout(handle);
    }
  }
}

function parseBody(text: string): unknown {
  if (text.length === 0) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    // A non-JSON body (e.g. a proxy's HTML error page) is still reported by its HTTP status.
    logger.debug(`Device Streaming returned a non-JSON body: ${errorMessage(error)}`);
    return undefined;
  }
}

function apiError(method: string, path: string, httpStatus: number, body: unknown): Error {
  const parsed = errorBodySchema.safeParse(body);
  const detail = parsed.success ? parsed.data.error : {};
  const status = detail.status ? ` ${detail.status}` : "";
  const message = detail.message ? `: ${detail.message}` : "";
  return new DeviceStreamingApiError(
    `Device Streaming ${method} ${path.split("?")[0]} failed with HTTP ${httpStatus}${status}${message}`,
    httpStatus,
    detail.status,
  );
}
