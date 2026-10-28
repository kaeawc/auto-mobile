/**
 * The reserved origin that addresses a mock backend (#14271): `<backendId>.mock.automobile.invalid`
 * (RFC 2606, never resolves). Requests to it are answered in process and never reach DNS.
 */
import { logger } from "../../utils/logger";

export const MOCK_ORIGIN_SUFFIX = ".mock.automobile.invalid";

export interface MockTarget {
  backendId: string;
  path: string;
  query: Record<string, string>;
}

/** The backend a URL addresses, or undefined when it is an ordinary destination. */
export function mockTargetOf(raw: string): MockTarget | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    // An unparseable URL is not a mock address; the real executor reports it as invalid_url.
    logger.debug("[PrototypeMock] URL parse failed.");
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    !host.endsWith(MOCK_ORIGIN_SUFFIX)
  ) {
    return undefined;
  }
  // Any host under the reserved suffix is a mock address, even one naming no valid backend: it must
  // fail as an unknown backend, never fall through to a DNS lookup.
  const backendId = host.slice(0, -MOCK_ORIGIN_SUFFIX.length);
  return { backendId, path: url.pathname, query: Object.fromEntries(url.searchParams) };
}
