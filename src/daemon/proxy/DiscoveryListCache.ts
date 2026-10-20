import { logger } from "../../utils/logger";
import type {
  ProxiedResourceDefinition,
  ProxiedResourceTemplate,
  ProxiedToolDefinition,
} from "../daemonMcpProxy";
import type { ConnectionRecovery } from "./ConnectionRecovery";

/** Structurally the server tier's ListChangedKind; declared here so daemon/ takes no upward import. */
type ListChangedKind = "tools" | "resources";

/** What a discovery fetch needs from the proxy that is not cache state itself. */
export interface DiscoveryListCachePort {
  /** Session-scoped params for a discovery request; `{}` after a result-minted release. */
  boundParams(releasedResultMint: boolean): Record<string, unknown>;
  withToolSelectionProfile(args: Record<string, unknown>): Record<string, unknown>;
  sessionUuidFromArgs(args: Record<string, unknown>): string | undefined;
  callDaemonMethod(method: string, params: Record<string, unknown>): Promise<any>;
  /** A freshly cached list, offered to the list_changed poller's baseline. */
  observeList(kind: ListChangedKind, list: unknown): void;
}

export interface DiscoveryListCacheDependencies {
  recovery: Pick<ConnectionRecovery, "withRecoverableReconnect">;
  port: DiscoveryListCachePort;
}

/**
 * Cached tools/resources/templates definitions fetched from the daemon, with the discovery epoch
 * that stops an in-flight response from repopulating a cache an invalidation just cleared
 * (issue #4655). Moved verbatim from DaemonMcpProxy; behaviour is unchanged.
 */
export class DiscoveryListCache {
  tools: ProxiedToolDefinition[] | null = null;
  resources: ProxiedResourceDefinition[] | null = null;
  resourceTemplates: ProxiedResourceTemplate[] | null = null;
  // Monotonic counter bumped whenever a daemon push invalidates a cache or the session binding
  // changes mid-flight. A fetch captures it at forward time and declines to store a response if
  // it has advanced by completion.
  epoch = 0;

  constructor(private readonly deps: DiscoveryListCacheDependencies) {}

  bumpEpoch(): void {
    this.epoch += 1;
  }

  /** Drop the cached definitions for one list kind and bump the epoch. */
  invalidateKind(kind: ListChangedKind): void {
    this.epoch += 1;
    if (kind === "tools") {
      this.tools = null;
    } else {
      this.resources = null;
      this.resourceTemplates = null;
    }
  }

  invalidateAll(): void {
    this.tools = null;
    this.resources = null;
    this.resourceTemplates = null;
  }

  async fetchTools(releasedResultMint: boolean): Promise<ProxiedToolDefinition[]> {
    if (this.tools) {
      return this.tools;
    }

    try {
      // Bind discovery to the session like callTool does. Without this, a recoverable reconnect
      // INSIDE withRecoverableReconnect retries tools/list with empty params against the fresh
      // UNSEEDED transport, which returns the full unfiltered tool list instead of the
      // session-scoped one (issue #4610). After a result-minted release there is no session to
      // bind: the connection lists the surface that contains the getAndroid/getApple recovery
      // tools (#9997).
      const epoch = this.epoch;
      const { port } = this.deps;
      const forwardedParams = port.withToolSelectionProfile(port.boundParams(releasedResultMint));
      const result = await this.deps.recovery.withRecoverableReconnect(
        () => port.callDaemonMethod("tools/list", port.withToolSelectionProfile(forwardedParams)),
        port.sessionUuidFromArgs(forwardedParams),
        releasedResultMint,
      );
      const tools: ProxiedToolDefinition[] = result?.tools ?? [];
      // A response invalidated mid-flight is scoped to the now-stale binding: return it to THIS
      // caller but leave the cache empty (issue #4655). The unbound list served after a
      // result-minted release is not cached either: a later explicit-sessionUuid call can re-bind
      // a surviving session without a cache invalidation.
      if (this.epoch === epoch && !releasedResultMint) {
        this.tools = tools;
        port.observeList("tools", tools);
      }
      return tools;
    } catch (error) {
      logger.error(`[DaemonMcpProxy] Failed to list tools: ${error}`);
      throw error;
    }
  }

  async fetchResources(releasedResultMint: boolean): Promise<ProxiedResourceDefinition[]> {
    if (this.resources) {
      return this.resources;
    }

    try {
      const epoch = this.epoch;
      const { port } = this.deps;
      const forwardedParams = port.boundParams(releasedResultMint);
      const result = await this.deps.recovery.withRecoverableReconnect(
        () => port.callDaemonMethod("resources/list", forwardedParams),
        port.sessionUuidFromArgs(forwardedParams),
        releasedResultMint,
      );
      const resources: ProxiedResourceDefinition[] = result?.resources ?? [];
      // Discard a response invalidated mid-flight (issue #4655). An unbound list after a
      // result-minted release is never cached: re-acquiring a session does not invalidate the
      // resource cache, so it would outlive the rebind.
      if (this.epoch === epoch && !releasedResultMint) {
        this.resources = resources;
        port.observeList("resources", resources);
      }
      return resources;
    } catch (error) {
      logger.error(`[DaemonMcpProxy] Failed to list resources: ${error}`);
      throw error;
    }
  }

  async fetchResourceTemplates(releasedResultMint: boolean): Promise<ProxiedResourceTemplate[]> {
    if (this.resourceTemplates) {
      return this.resourceTemplates;
    }

    try {
      const epoch = this.epoch;
      const { port } = this.deps;
      const forwardedParams = port.boundParams(releasedResultMint);
      const result = await this.deps.recovery.withRecoverableReconnect(
        () => port.callDaemonMethod("resources/list-templates", forwardedParams),
        port.sessionUuidFromArgs(forwardedParams),
        releasedResultMint,
      );
      const templates: ProxiedResourceTemplate[] = result?.resourceTemplates ?? [];
      // Discard a response invalidated mid-flight; not cached while unbound after a
      // result-minted release (see fetchResources).
      if (this.epoch === epoch && !releasedResultMint) {
        this.resourceTemplates = templates;
      }
      return templates;
    } catch (error) {
      logger.error(`[DaemonMcpProxy] Failed to list resource templates: ${error}`);
      throw error;
    }
  }
}
