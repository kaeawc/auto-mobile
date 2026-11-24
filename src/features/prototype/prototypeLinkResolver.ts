import {
  matchPrototypeLink,
  type PrototypeLinkEntry,
  type PrototypeLinkMatch,
} from "./prototypeLinkMatcher";

export interface PrototypeLinkRegistration {
  /** Custom schemes, including the host's amp-<slug> scheme. */
  schemes: readonly string[];
  /** Web schemes require an explicit scheme AND host registration. No default web registration. */
  web?: readonly { scheme: string; host: string }[];
}

/** Registration guard only: retain the matcher's raw custom authority/path semantics. */
export function resolvePrototypeLink(
  url: string,
  registration: PrototypeLinkRegistration,
  entries: readonly PrototypeLinkEntry[],
): PrototypeLinkMatch | undefined {
  const separator = url.indexOf("://");
  if (separator <= 0) {
    return undefined;
  }
  const scheme = url.slice(0, separator).toLowerCase();
  if (scheme === "http" || scheme === "https") {
    const parsed = URL.parse(url);
    if (
      !parsed ||
      parsed.username ||
      parsed.password ||
      !registration.web?.some(
        (entry) =>
          entry.scheme.toLowerCase() === scheme &&
          entry.host.toLowerCase() === parsed.host.toLowerCase(),
      )
    ) {
      return undefined;
    }
  } else if (!registration.schemes.some((entry) => entry.toLowerCase() === scheme)) {
    return undefined;
  }
  return matchPrototypeLink(url, entries);
}
