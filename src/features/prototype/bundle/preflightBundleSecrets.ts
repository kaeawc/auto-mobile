import { expandPrototypeComponents } from "../prototypeComponents";
import { isIP } from "node:net";
import { classifyAddress, StrictEgressPolicy } from "../prototypeEgressPolicy";
import { walkPrototypeNodes } from "../prototypeNodeChildren";
import { mapBindableFields, record } from "../prototypeTemplate";

export interface BundleSecretWarning {
  code: "secret_header" | "secret_query" | "private_host";
  path: string;
  /** Header/query name or host only; never includes a secret value. */
  name: string;
}
const secretHeader = /^(?:authorization|cookie|x-api-key)$/i;
const secretQuery = /^(?:token|key|secret|sig)$/i;
const hostPolicy = new StrictEgressPolicy(new Set());
function parseUrl(value: string): URL | undefined {
  return URL.canParse(value) ? new URL(value) : undefined;
}
function warnHost(url: URL, path: string, out: BundleSecretWarning[]): void {
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!hostPolicy.permitsHostname(host) || (isIP(host) && classifyAddress(host) !== "public")) {
    out.push({ code: "private_host", path: `${path}.url`, name: host });
  }
}
function requestWarnings(
  action: Record<string, unknown>,
  path: string,
  out: BundleSecretWarning[],
): void {
  for (const name of Object.keys(record(action.headers) ?? {})) {
    if (secretHeader.test(name)) {
      out.push({ code: "secret_header", path: `${path}.headers`, name });
    }
  }
  const query = new Set(Object.keys(record(action.query) ?? {}));
  const url = typeof action.url === "string" ? parseUrl(action.url) : undefined;
  if (url) {
    for (const key of url.searchParams.keys()) {
      query.add(key);
    }
    warnHost(url, path, out);
  }
  for (const name of query) {
    if (secretQuery.test(name)) {
      out.push({ code: "secret_query", path: `${path}.query`, name });
    }
  }
}
/** Advisory, no DNS/network and no secret values in diagnostics. Call on a validated spec. */
export function preflightBundleSecrets(spec: unknown): BundleSecretWarning[] {
  const out: BundleSecretWarning[] = [];
  const expansion = expandPrototypeComponents(spec);
  if (!expansion.success) {
    return out;
  }
  walkPrototypeNodes(expansion.spec, (node, path) => {
    mapBindableFields(node, path, (value, at, kind) => {
      const action = record(value);
      if (kind === "request" && action) {
        requestWarnings(action, at, out);
      }
      return value;
    });
  });
  return out;
}
