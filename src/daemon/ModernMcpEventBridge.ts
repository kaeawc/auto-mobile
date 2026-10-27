import type { ServerEventBus, SubscriptionFilter } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { logger } from "../utils/logger";
import { ListChangedBroadcaster } from "./listChangedBroadcast";
import {
  ResourceUpdatedBroadcaster,
  type ResourceUpdateTargets,
} from "./ResourceUpdatedBroadcasterClass";

interface ModernMcpEventBridgeDeps {
  readonly updates: Pick<typeof ResourceUpdatedBroadcaster, "subscribe">;
  readonly lists: Pick<typeof ListChangedBroadcaster, "subscribe">;
  readonly log: Pick<typeof logger, "warn">;
  readonly maxUrisPerStream: number;
  /** Counts memberships, including a URI repeated on different streams. */
  readonly maxUriMemberships: number;
}

const DEFAULT_DEPS: ModernMcpEventBridgeDeps = {
  updates: ResourceUpdatedBroadcaster,
  lists: ListChangedBroadcaster,
  log: logger,
  maxUrisPerStream: 256,
  maxUriMemberships: 4096,
};

// Read only the wire fields this bridge owns; the SDK validates the complete request.
const listenResources = z.object({
  method: z.literal("subscriptions/listen"),
  params: z.object({
    notifications: z.object({
      resourceSubscriptions: z.array(z.string()).optional(),
    }) satisfies z.ZodType<Pick<SubscriptionFilter, "resourceSubscriptions">>,
  }),
});

/** Endpoint-scoped fan-out; constructed only when modern serving is enabled. */
export class ModernMcpEventBridge {
  private readonly uriReferences = new Map<string, number>();
  private memberships = 0;
  private warnedLimit = false;
  private readonly unsubscribeUpdates: () => void;
  private readonly unsubscribeLists: () => void;
  private readonly deps: ModernMcpEventBridgeDeps;

  constructor(
    private readonly bus: Pick<ServerEventBus, "publish">,
    deps: Partial<ModernMcpEventBridgeDeps> = {},
  ) {
    this.deps = { ...DEFAULT_DEPS, ...deps };
    this.unsubscribeUpdates = this.deps.updates.subscribe((resolve) =>
      this.publishUpdated(resolve),
    );
    this.unsubscribeLists = this.deps.lists.subscribe((kind) => {
      this.bus.publish({
        kind: kind === "tools" ? "tools_list_changed" : "resources_list_changed",
      });
    });
  }

  /** Reserve exact URI memberships until this request closes; null refuses the whole stream. */
  track(body: unknown): (() => void) | null {
    const parsed = listenResources.safeParse(body);
    if (!parsed.success) {
      // The SDK reports invalid requests; they cannot establish a listen stream.
      return () => {};
    }
    const uris = new Set(parsed.data.params.notifications.resourceSubscriptions ?? []);
    if (
      uris.size > this.deps.maxUrisPerStream ||
      this.memberships + uris.size > this.deps.maxUriMemberships
    ) {
      if (!this.warnedLimit) {
        this.warnedLimit = true;
        this.deps.log.warn("Modern MCP resource subscription URI limit reached; refusing stream");
      }
      return null;
    }
    for (const uri of uris) {
      this.uriReferences.set(uri, (this.uriReferences.get(uri) ?? 0) + 1);
    }
    this.memberships += uris.size;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.release(uris);
      }
    };
  }

  close(): void {
    this.unsubscribeUpdates();
    this.unsubscribeLists();
    this.uriReferences.clear();
    this.memberships = 0;
  }

  private release(uris: Set<string>): void {
    for (const uri of uris) {
      const count = this.uriReferences.get(uri);
      if (count === undefined) {
        continue;
      }
      this.memberships--;
      if (count === 1) {
        this.uriReferences.delete(uri);
      } else {
        this.uriReferences.set(uri, count - 1);
      }
    }
  }

  private publishUpdated(resolve: ResourceUpdateTargets): void {
    if (this.uriReferences.size === 0) {
      return;
    }
    try {
      // Give resolvers a snapshot so they cannot mutate the tracking or retain request bodies.
      const targets = new Set(resolve(new Set(this.uriReferences.keys())));
      for (const uri of targets) {
        if (this.uriReferences.has(uri)) {
          this.publishUri(uri);
        }
      }
    } catch (error) {
      this.deps.log.warn("Modern MCP resource update resolution failed", error);
    }
  }

  private publishUri(uri: string): void {
    try {
      this.bus.publish({ kind: "resource_updated", uri });
    } catch (error) {
      this.deps.log.warn("Modern MCP resource update publication failed", error);
    }
  }
}
