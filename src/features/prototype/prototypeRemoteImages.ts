import contract from "../../../schemas/prototype-spec-contract.json";
import { prototypeContractPatterns } from "./prototypeContractPatterns";
import { prototypeRequestUrlError } from "./prototypeRequest";
import { walkPrototypeNodes } from "./prototypeNodeChildren";
import { STATE_KEY, record, type Raw } from "./prototypeTemplate";
import { dataPlaceholderSpans, prototypeBindingSpans } from "./prototypeData";

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
    const accessory = record(record(node.ios)?.bottomAccessory);
    if (accessory) {
      fields.push(
        ...prototypeRemoteImageFields({ root: accessory }).map(
          (field) => `${path}.ios.bottomAccessory${field.slice(4)}`,
        ),
      );
    }
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
    const missing = undeclaredStateReference(url, declared);
    if (missing) {
      return {
        path: `${path}.url`,
        message: "Remote image URL references an undeclared state key",
      };
    }
    const failure = staticUrlFailure(url, node.via);
    if (failure) {
      return { path: `${path}.${failure.field}`, message: failure.message };
    }
  }
  return undefined;
}

function staticUrlFailure(
  url: string,
  via: unknown,
): { field: "url" | "via"; message: string } | undefined {
  if (via === "host" && url.includes("{")) {
    return { field: "via", message: "Host remote images require a static URL" };
  }
  // Whole-field bindings follow the existing string validators; loaders validate their resolved value.
  if (/^\{[^{}]+\}$/.test(url)) {
    return undefined;
  }
  const message = prototypeRequestUrlError(url) ?? remoteImageTransportError(url);
  return message ? { field: "url", message } : undefined;
}

function undeclaredStateReference(url: string, declared: Raw): boolean {
  const consumed = prototypeBindingSpans(url);
  return Array.from(dataPlaceholderSpans(url, "", (key) => STATE_KEY.test(key))).some(
    ({ pointer, start }) =>
      !consumed.some((span) => span.start <= start && start < span.end) &&
      pointer !== "index" &&
      !Object.hasOwn(declared, pointer),
  );
}

/** Static transport policy; loaders apply it again after bindings and redirects. */
function remoteImageTransportError(url: string): string | undefined {
  const authority = /^https?:\/\/([^/?#]+)/i.exec(url)?.[1];
  const insecure =
    /^http:/i.test(url) &&
    !/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?(?:[/?#]|$)/i.test(url);
  return !authority ||
    authority.startsWith(":") ||
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
