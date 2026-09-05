import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  Resource,
  ResourceTemplate,
  ReadResourceRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { logger } from "../utils/logger";
import { ListChangedBroadcaster } from "./listChangedBroadcast";

export interface ResourceReadContext {
  sessionUuid?: string;
  /** A released session identity, available only to handlers that safely report inactivity. */
  releasedSessionUuid?: string;
  signal?: AbortSignal;
}

// Interface for resource content handlers
interface ResourceHandler {
  (): Promise<ResourceContent>;
}

// Interface for resource template handlers (with parameters)
interface ResourceTemplateHandler {
  (params: Record<string, string>): Promise<ResourceContent>;
}

interface ContextualResourceTemplateHandler {
  (params: Record<string, string>, context: ResourceReadContext): Promise<ResourceContent>;
}

// Resource content can be text or blob
export interface ResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string; // base64 encoded
}

// Interface for a registered resource
interface ResourceMetadata {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  handler: ResourceHandler;
}

type RegisteredResource = ResourceMetadata;

interface ResourceTemplateMetadata {
  uriTemplate: string;
  name: string;
  description?: string;
  mimeType?: string;
  // Precompiled at registration so matchTemplate never compiles a RegExp inside
  // the per-request scan (issue #3427). Patterns are 100% static.
  regex: RegExp;
  paramNames: string[];
  queryParamNames: string[];
}

const requestedResourceUri = Symbol("requestedResourceUri");

export function getRequestedResourceUri(params: Record<string, string>): string | undefined {
  return (params as Record<PropertyKey, unknown>)[requestedResourceUri] as string | undefined;
}

type RegisteredResourceTemplate = ResourceTemplateMetadata &
  (
    | { handler: ResourceTemplateHandler }
    | { handlerWithReadContext: ContextualResourceTemplateHandler }
  );

// Compile an RFC 6570 URI template into an anchored RegExp plus its ordered
// parameter names. Pure and called once per template at registration.
// E.g. "automobile:emulators/{id}" -> /^automobile:emulators\/([^/&]+)$/, ["id"]
function compileUriTemplate(template: string): {
  regex: RegExp;
  paramNames: string[];
  queryParamNames: string[];
} {
  const queryExpression = template.match(/\{\?([a-zA-Z0-9_]+(?:,[a-zA-Z0-9_]+)*)\}$/);
  const queryParamNames = queryExpression?.[1].split(",") ?? [];
  const pathTemplate = queryExpression
    ? template.slice(0, template.length - queryExpression[0].length)
    : template;
  const paramNames: string[] = [];
  const tokenizedTemplate = pathTemplate.replace(/\{(\w+)\}/g, (_, paramName) => {
    paramNames.push(paramName);
    return `__PARAM_${paramNames.length - 1}__`;
  });
  const escapedTemplate = tokenizedTemplate.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  // Use [^/&]+ so regular query-string params stop at the & delimiter; trailing
  // {path} and {params} params are greedy for nested paths and raw query strings.
  const regexPattern = escapedTemplate.replace(/__PARAM_(\d+)__/g, (_placeholder, indexText) => {
    const index = Number(indexText);
    const isGreedyTrailingParam =
      (paramNames[index] === "path" || paramNames[index] === "params") &&
      escapedTemplate.endsWith(`__PARAM_${index}__`);
    return isGreedyTrailingParam ? "(.+)" : "([^/&]+)";
  });

  const querySuffix = queryParamNames.length > 0 ? "(?:\\?[^#]*)?" : "";
  return {
    regex: new RegExp(`^${regexPattern}${querySuffix}$`),
    paramNames,
    queryParamNames,
  };
}

// Run a precompiled template's regex against a URI and, on a match, extract the
// named parameters. Returns null when the URI does not match the template.
function extractTemplateParams(
  template: RegisteredResourceTemplate,
  uri: string,
): Record<string, string> | null {
  const match = uri.match(template.regex);
  if (!match) {
    return null;
  }

  const params: Record<string, string> = Object.create(null);
  template.paramNames.forEach((name, index) => {
    params[name] = match[index + 1];
  });
  if (template.queryParamNames.length > 0) {
    const declaredQueryParams = new Set(template.queryParamNames);
    const queryStart = uri.indexOf("?");
    const query = queryStart >= 0 ? uri.slice(queryStart + 1) : "";
    const seen = new Set<string>();
    for (const [name, value] of new URLSearchParams(query)) {
      if (seen.has(name)) {
        return null;
      }
      seen.add(name);
      // Only declared `{?a,b}` query variables are captured. An undeclared
      // query key (issue #6188) — including one that collides with a
      // path-captured param name like `deviceId` — is ignored rather than
      // silently overwriting the path capture.
      if (!declaredQueryParams.has(name)) {
        continue;
      }
      params[name] = value;
    }
  }
  Object.defineProperty(params, requestedResourceUri, { value: uri });

  return params;
}

// The registry that holds all resources
class ResourceRegistryClass {
  private resources: Map<string, RegisteredResource> = new Map();
  private templates: Map<string, RegisteredResourceTemplate> = new Map();
  // Every live MCP server this registry has been registered with. In daemon
  // mode `registerWithServer` runs once per HTTP session, so notifications must
  // fan out to ALL live sessions — a single retained server would be
  // last-writer-wins (issue #3223). Entries are pruned via the underlying
  // server's onclose hook when a session's transport closes.
  private servers: Set<McpServer> = new Set();
  private subscriptions: Set<string> = new Set();

  // Register a new resource
  register(
    uri: string,
    name: string,
    description: string,
    mimeType: string,
    handler: ResourceHandler,
  ): void {
    this.resources.set(uri, { uri, name, description, mimeType, handler });
  }

  // Register a new resource template (RFC 6570 URI template)
  registerTemplate(
    uriTemplate: string,
    name: string,
    description: string,
    mimeType: string,
    handler: ResourceTemplateHandler,
  ): void {
    const { regex, paramNames, queryParamNames } = compileUriTemplate(uriTemplate);
    this.templates.set(uriTemplate, {
      uriTemplate,
      name,
      description,
      mimeType,
      handler,
      regex,
      paramNames,
      queryParamNames,
    });
  }

  registerTemplateWithReadContext(
    uriTemplate: string,
    name: string,
    description: string,
    mimeType: string,
    handlerWithReadContext: ContextualResourceTemplateHandler,
  ): void {
    const { regex, paramNames, queryParamNames } = compileUriTemplate(uriTemplate);
    this.templates.set(uriTemplate, {
      uriTemplate,
      name,
      description,
      mimeType,
      handlerWithReadContext,
      regex,
      paramNames,
      queryParamNames,
    });
  }

  // Get all registered templates
  getAllTemplates(): RegisteredResourceTemplate[] {
    return Array.from(this.templates.values());
  }

  // Get a specific template by URI template
  getTemplate(uriTemplate: string): RegisteredResourceTemplate | undefined {
    return this.templates.get(uriTemplate);
  }

  // Match a URI against registered templates and return the template and extracted parameters
  matchTemplate(
    uri: string,
  ): { template: RegisteredResourceTemplate; params: Record<string, string> } | undefined {
    for (const registeredTemplate of this.templates.values()) {
      const params = extractTemplateParams(registeredTemplate, uri);
      if (params) {
        return { template: registeredTemplate, params };
      }
    }
    return undefined;
  }

  // Get all registered resources
  getAllResources(): RegisteredResource[] {
    return Array.from(this.resources.values());
  }

  // Get a specific resource by URI
  getResource(uri: string): RegisteredResource | undefined {
    return this.resources.get(uri);
  }

  // Unregister a resource by URI
  unregister(uri: string): void {
    this.resources.delete(uri);
  }

  // Get resources in MCP format for ListResources response
  getResourceDefinitions(): Resource[] {
    return Array.from(this.resources.values()).map((resource) => ({
      uri: resource.uri,
      name: resource.name,
      description: resource.description,
      mimeType: resource.mimeType,
    }));
  }

  // Get resource templates in MCP format for ListResourceTemplates response
  getTemplateDefinitions(): ResourceTemplate[] {
    return Array.from(this.templates.values()).map((template) => ({
      uriTemplate: template.uriTemplate,
      name: template.name,
      description: template.description,
      mimeType: template.mimeType,
    }));
  }

  // Track a server for notification fan-out and prune it when its session's
  // transport closes. The underlying Protocol preserves a pre-set `onclose`
  // (both the transport's and the server's), so chaining here cannot clobber
  // other lifecycle hooks (e.g. ToolRegistry's identical prune hook).
  private trackServer(server: McpServer): void {
    if (this.servers.has(server)) {
      return;
    }
    this.servers.add(server);
    const underlying = server.server;
    const existingOnClose = underlying.onclose;
    underlying.onclose = () => {
      this.servers.delete(server);
      existingOnClose?.();
    };
  }

  // Register all resources with an MCP server
  registerWithServer(
    server: McpServer,
    getReadContext: (signal: AbortSignal) => ResourceReadContext = () => ({}),
  ): void {
    this.trackServer(server);

    // Set handler for listing resources
    server.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      return {
        resources: this.getResourceDefinitions(),
      };
    });

    // Set handler for reading resource content
    server.server.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => {
      const { uri } = request.params;
      logger.info(`[ResourceRegistry] ReadResource request for URI: ${uri}`);

      // Check for common incorrect URI schemes and provide helpful error
      // messages. `automobile:` is the data-resource scheme; `ui:` is the MCP
      // Apps UI-resource scheme (issue #4669). Anything else is a typo — but
      // only reject when no resource is actually registered under that exact
      // URI, so a future scheme that registers real resources still resolves.
      const schemeMatch = uri.match(/^([a-z][a-z0-9+.-]*):\/?\/?/i);
      if (schemeMatch) {
        const scheme = schemeMatch[1].toLowerCase();
        if (scheme !== "automobile" && scheme !== "ui" && !this.getResource(uri)) {
          const suggestedUri = uri.replace(/^[a-z][a-z0-9+.-]*:\/?\/?/i, "automobile:");
          throw new Error(
            `Unknown URI scheme '${scheme}://'. AutoMobile resources use the 'automobile:' prefix. ` +
              `Try: ${suggestedUri}`,
          );
        }
      }

      // First, try to find an exact match resource
      const resource = this.getResource(uri);
      if (resource) {
        const content = await resource.handler();
        return {
          contents: [content],
        };
      }

      // If not found, try to match a template
      const templateMatch = this.matchTemplate(uri);
      if (templateMatch) {
        const { template, params } = templateMatch;
        const content =
          "handlerWithReadContext" in template
            ? await template.handlerWithReadContext(params, getReadContext(extra.signal))
            : await template.handler(params);
        return {
          contents: [content],
        };
      }

      // Provide helpful error message with available resource patterns
      throw new Error(
        `Resource not found: ${uri}\n\n` +
          `Available resource patterns:\n` +
          `  - automobile:devices/booted - List all booted devices\n` +
          `  - automobile:devices/booted/{platform} - List devices by platform (android|ios)\n` +
          `  - automobile:devices/{deviceId}/apps - List apps for a device\n` +
          `  - automobile:apps?deviceId={deviceId} - Query apps with filters\n` +
          `  - automobile:observation/latest - Latest screen observation\n\n` +
          `Use the listApps tool for detailed guidance on listing apps.`,
      );
    });

    // Set handler for listing resource templates
    server.server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
      return {
        resourceTemplates: this.getTemplateDefinitions(),
      };
    });

    // Set handler for subscribe
    server.server.setRequestHandler(SubscribeRequestSchema, async (request) => {
      const { uri } = request.params;
      this.subscriptions.add(uri);
      logger.info(`[ResourceRegistry] Client subscribed to: ${uri}`);
      return {};
    });

    // Set handler for unsubscribe
    server.server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
      const { uri } = request.params;
      this.subscriptions.delete(uri);
      logger.info(`[ResourceRegistry] Client unsubscribed from: ${uri}`);
      return {};
    });
  }

  // Check if a URI is subscribed
  isSubscribed(uri: string): boolean {
    return this.subscriptions.has(uri);
  }

  // Get all active subscriptions
  getSubscriptions(): Set<string> {
    return new Set(this.subscriptions);
  }

  // Send resource update notification (only if client is subscribed)
  async notifyResourceUpdated(uri: string): Promise<void> {
    if (!this.subscriptions.has(uri)) {
      return;
    }

    const resource = this.getResource(uri);
    const templateMatch = resource ? undefined : this.matchTemplate(uri);
    if (!resource && !templateMatch) {
      return;
    }

    // Subscriptions are tracked registry-wide, so every live session's server
    // gets the update (issue #3223) — best-effort per server.
    for (const server of this.servers) {
      try {
        // Send notification to clients that resource has changed
        await server.server.notification({
          method: "notifications/resources/updated",
          params: {
            uri: resource ? resource.uri : uri,
          },
        });
      } catch (error) {
        // Silently ignore notification errors (e.g., when transport is not connected during tests)
        logger.debug(`[ResourceRegistry] Failed to notify resource update for ${uri}: ${error}`);
      }
    }
  }

  // Send notifications for multiple resources
  async notifyResourcesUpdated(uris: string[]): Promise<void> {
    for (const uri of uris) {
      await this.notifyResourceUpdated(uri);
    }
  }

  // Send notification that the resource list has changed. Fans out to every
  // live session's server (issue #3223), and the ListChangedBroadcaster carries
  // the event to non-MCP transports — the daemon's Unix socket server pushes it
  // to connected DaemonMcpProxy clients, which invalidate their resource caches
  // and re-emit to their own external clients.
  async notifyResourceListChanged(): Promise<void> {
    for (const server of this.servers) {
      try {
        await server.server.notification({
          method: "notifications/resources/list_changed",
          params: {},
        });
      } catch (error) {
        // Best-effort: a failed notification must never break the resource
        // change that triggered it, nor block sibling sessions.
        logger.warn(`[ResourceRegistry] Failed to notify resource list change: ${error}`);
      }
    }
    ListChangedBroadcaster.emit("resources");
  }

  // Test-only: drop tracked servers so suites sharing the singleton stay hermetic.
  clearServersForTesting(): void {
    this.servers.clear();
  }

  // Clear all registered resources, templates, and subscriptions (for testing)
  clearResources(): void {
    this.resources.clear();
    this.templates.clear();
    this.subscriptions.clear();
  }
}

// Export a singleton instance
export const ResourceRegistry = new ResourceRegistryClass();
