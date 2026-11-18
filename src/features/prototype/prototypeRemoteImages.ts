import contract from "../../../schemas/prototype-spec-contract.json";
import { prototypeContractPatterns } from "./prototypeContractPatterns";
import { prototypeRequestUrlError } from "./prototypeRequest";
import { walkPrototypeNodes } from "./prototypeNodeChildren";
import { STATE_KEY, record, type Raw } from "./prototypeTemplate";
import { dataPlaceholderSpans } from "./prototypeData";

import { PROTOTYPE_REMOTE_IMAGE_CAPABILITY } from "../observe/android/ctrlProxyProtocol";
export { PROTOTYPE_REMOTE_IMAGE_CAPABILITY };
export const MAX_PROTOTYPE_REMOTE_IMAGE_URL_LENGTH = 2048;
export const MAX_PROTOTYPE_REMOTE_IMAGE_DOWNLOAD_BYTES =
  contract.limits.MAX_PROTOTYPE_REMOTE_IMAGE_DOWNLOAD_BYTES;
export const PROTOTYPE_REMOTE_IMAGE_ANDROID_HEAP_DIVISOR =
  contract.limits.PROTOTYPE_REMOTE_IMAGE_ANDROID_HEAP_DIVISOR;
export const MAX_PROTOTYPE_REMOTE_IMAGE_IOS_MEMORY_BYTES =
  contract.limits.MAX_PROTOTYPE_REMOTE_IMAGE_IOS_MEMORY_BYTES;
export const MAX_PROTOTYPE_REMOTE_IMAGE_DISK_BYTES =
  contract.limits.MAX_PROTOTYPE_REMOTE_IMAGE_DISK_BYTES;
export const MAX_PROTOTYPE_REMOTE_IMAGE_LOADS = contract.limits.MAX_PROTOTYPE_REMOTE_IMAGE_LOADS;
const FIELDS = ["url", "placeholder", "error", "crossfade", "via"];

export function prototypeRemoteImageFields(spec: unknown): string[] {
  const fields: string[] = [];
  walkPrototypeNodes(spec, (node, path) => {
    if (node.type === "image") {
      fields.push(
        ...FIELDS.filter((field) => node[field] !== undefined).map((field) => `${path}.${field}`),
      );
    }
  });
  return fields;
}

/** Contract only. Loopback HTTP is reserved for development fixtures; loaders must enforce flavor. */
export function prototypeRemoteImageError(
  nodes: readonly { value: Raw; path: string }[],
  state: unknown,
): { path: string; message: string } | undefined {
  const declared = record(state) ?? {};
  for (const { value: node, path } of nodes) {
    if (node.type !== "image") {
      continue;
    }
    if ((node.asset !== undefined) === (node.url !== undefined)) {
      return { path, message: "image requires exactly one of asset or url" };
    }
    if (typeof node.url !== "string") {
      continue;
    }
    const url = node.url;
    const missing = Array.from(dataPlaceholderSpans(url, "", (key) => STATE_KEY.test(key))).find(
      ({ pointer }) => pointer !== "index" && !Object.hasOwn(declared, pointer),
    );
    if (missing) {
      return {
        path: `${path}.url`,
        message: "Remote image URL references an undeclared state key",
      };
    }
    if (node.via === "host" && url.includes("{")) {
      return { path: `${path}.via`, message: "Host remote images require a static URL" };
    }
    // Whole-field bindings follow the existing string validators; loaders validate their resolved value.
    if (url.startsWith("{")) {
      continue;
    }
    const problem = prototypeRequestUrlError(url);
    if (problem) {
      return { path: `${path}.url`, message: problem };
    }
    const security = remoteImageTransportError(url);
    if (security) {
      return { path: `${path}.url`, message: security };
    }
  }
  return undefined;
}

/** Static transport policy; loaders apply it again after bindings and redirects. */
function remoteImageTransportError(url: string): string | undefined {
  const authority = /^https?:\/\/([^/?#]+)/i.exec(url)?.[1];
  const insecure =
    /^http:/i.test(url) &&
    !/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?(?:[/?#]|$)/i.test(url);
  return !authority ||
    /[@\\]/.test(authority) ||
    Array.from(url).some(
      (char) =>
        prototypeContractPatterns.blankText.test(char) ||
        /[\\\u0000-\u001f\u007f-\u009f]/.test(char),
    ) ||
    insecure
    ? "Remote image URL requires HTTPS or literal loopback HTTP, without credentials, whitespace or backslashes"
    : undefined;
}
