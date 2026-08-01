import { Timer, defaultTimer } from "../../utils/SystemTimer";
import { RequestResponseSocketServer } from "./RequestResponseSocketServer";
import { SocketRequest, SocketResponse } from "./SocketServerTypes";
import type { StreamSocketAuthenticator } from "../streamSocketAuth";

export type ConfigSocketMethod = "config/get" | "config/set";

export interface ConfigSocketRequest<
  TRequestType extends string,
  TInput,
> extends SocketRequest {
  id: string;
  type: TRequestType;
  method: ConfigSocketMethod;
  /** Daemon session on whose behalf a mutating request is made (issue #4752). */
  sessionUuid?: string;
  params?: {
    config?: TInput | null;
  };
}

export type ConfigSocketResult<
  TConfig,
  TEvictedKey extends string,
> = {
  config: TConfig;
} & Partial<Record<TEvictedKey, string[]>>;

export interface ConfigSocketResponse<
  TResponseType extends string,
  TConfig,
  TEvictedKey extends string,
> extends SocketResponse {
  id: string;
  type: TResponseType;
  success: boolean;
  result?: ConfigSocketResult<TConfig, TEvictedKey>;
  error?: string;
}

interface ConfigSocketUpdateResult<TConfig> {
  config: TConfig;
  evictedItems: string[];
}

interface ConfigSocketServerOptions<
  TConfig,
  TInput,
  TResponseType extends string,
  TEvictedKey extends string,
> {
  socketPath: string;
  timer?: Timer;
  serverName: string;
  responseType: TResponseType;
  evictedKey: TEvictedKey;
  methodLabel: string;
  getConfig: () => Promise<TConfig>;
  updateConfig: (update: TInput | null) => Promise<ConfigSocketUpdateResult<TConfig>>;
  /**
   * Authorizes mutating (`config/set`) requests (issue #4752). When provided, an
   * unauthenticated or cross-session request is rejected before the config
   * change — which can trigger global archive eviction — is applied. Omitted by
   * sockets that carry no session-scoped side effects.
   */
  authenticator?: StreamSocketAuthenticator;
}

/**
 * Request-response socket server for daemon config endpoints.
 * Handles the shared config/get and config/set protocol used by config-only sockets.
 */
export class ConfigSocketServer<
  TConfig,
  TInput,
  TRequestType extends string,
  TResponseType extends string,
  TEvictedKey extends string,
> extends RequestResponseSocketServer<
  ConfigSocketRequest<TRequestType, TInput>,
  ConfigSocketResponse<TResponseType, TConfig, TEvictedKey>
> {
  private readonly responseType: TResponseType;
  private readonly evictedKey: TEvictedKey;
  private readonly methodLabel: string;
  private readonly getConfig: () => Promise<TConfig>;
  private readonly updateConfig: (update: TInput | null) => Promise<ConfigSocketUpdateResult<TConfig>>;
  private readonly authenticator?: StreamSocketAuthenticator;

  constructor(
    options: ConfigSocketServerOptions<TConfig, TInput, TResponseType, TEvictedKey>
  ) {
    super(options.socketPath, options.timer ?? defaultTimer, options.serverName);
    this.responseType = options.responseType;
    this.evictedKey = options.evictedKey;
    this.methodLabel = options.methodLabel;
    this.getConfig = options.getConfig;
    this.updateConfig = options.updateConfig;
    this.authenticator = options.authenticator;
  }

  protected async handleRequest(
    request: ConfigSocketRequest<TRequestType, TInput>
  ): Promise<ConfigSocketResponse<TResponseType, TConfig, TEvictedKey>> {
    switch (request.method) {
      case "config/get": {
        const config = await this.getConfig();
        return {
          id: request.id,
          type: this.responseType,
          success: true,
          result: { config } as ConfigSocketResult<TConfig, TEvictedKey>,
        };
      }
      case "config/set": {
        // Authorize before the mutation: lowering maxArchiveSizeMb here triggers
        // global archive eviction, so a cross-session request must be rejected
        // first (issue #4752).
        this.authenticator?.authorize({ sessionUuid: request.sessionUuid });
        if (!request.params || !("config" in request.params)) {
          throw new Error("config/set requires params.config");
        }
        const update = request.params.config ?? null;
        const { config, evictedItems } = await this.updateConfig(update);
        const result = { config } as ConfigSocketResult<TConfig, TEvictedKey>;
        if (evictedItems.length > 0) {
          (result as Record<string, unknown>)[this.evictedKey] = evictedItems;
        }
        return {
          id: request.id,
          type: this.responseType,
          success: true,
          result,
        };
      }
      default:
        throw new Error(`Unsupported ${this.methodLabel} method: ${String(request.method)}`);
    }
  }

  protected createErrorResponse(
    id: string | undefined,
    error: string
  ): ConfigSocketResponse<TResponseType, TConfig, TEvictedKey> {
    return {
      id: id ?? "unknown",
      type: this.responseType,
      success: false,
      error,
    };
  }
}
