import { expandPrototypeComponents } from "../prototypeComponents";
import { isIP } from "node:net";
import { classifyAddress, StrictEgressPolicy } from "../prototypeEgressPolicy";
import { walkPrototypeNodes } from "../prototypeNodeChildren";
import { mapBindableFields, record } from "../prototypeTemplate";

export interface BundleSecretWarning {
  code: "secret_header" | "secret_query" | "secret_userinfo" | "private_host";
  path: string;
  /** Header/query name or host only; never includes a secret value. */
  name: string;
}
const secretHeader = /^(?:authorization|proxy-authorization|cookie|x-api-key|x-auth-token)$/i;
const secretQuery =
  /^(?:token|access_token|id_token|refresh_token|key|api_key|apikey|secret|client_secret|sig|signature|password)$/i;
const hostPolicy = new StrictEgressPolicy(new Set());
function parseUrl(value: string): URL | undefined {
  return URL.canParse(value) ? new URL(value) : undefined;
}
function warnHost(url: URL, path: string, out: BundleSecretWarning[]): void {
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (
    !hostPolicy.permitsHostname(host) ||
    /\.(?:internal|local|lan|localhost)$/i.test(host) ||
    (isIP(host) && classifyAddress(host) !== "public")
  ) {
    out.push({ code: "private_host", path: `${path}.url`, name: host });
  }
}
function queryParams(value: string, url: URL | undefined): URLSearchParams {
  if (url) {
    return url.searchParams;
  }
  // Strip the fragment first: a question mark inside it is not a query delimiter.
  const beforeFragment = value.split("#", 1)[0]!;
  const at = beforeFragment.indexOf("?");
  // URLSearchParams supplies the standard &, =, percent and + decoding offline.
  return new URLSearchParams(at < 0 ? "" : beforeFragment.slice(at + 1));
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
  const urlText = typeof action.url === "string" ? action.url : "";
  const url = parseUrl(urlText);
  for (const key of queryParams(urlText, url).keys()) {
    query.add(key);
  }
  if (url) {
    if (url.username || url.password) {
      out.push({ code: "secret_userinfo", path: `${path}.url`, name: "userinfo" });
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
