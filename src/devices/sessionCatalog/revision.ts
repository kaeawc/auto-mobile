import { createHash } from "node:crypto";

/** Stable identity for one normalized native-catalog snapshot and adapter policy. */
export function nativeCatalogRevision(source: string, value: unknown): string {
  const digest = createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
  return `${source}:sha256:${digest}`;
}
