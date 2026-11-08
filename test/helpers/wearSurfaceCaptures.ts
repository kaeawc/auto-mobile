import { readFileSync } from "node:fs";
import path from "node:path";
import { parseStringPromise } from "xml2js";
import type { ObserveResult, ViewHierarchyResult } from "../../src/models";

const fixtures = path.join(import.meta.dir, "../fixtures/wear");
const fixture = (name: string) => readFileSync(path.join(fixtures, name), "utf8");

/** Preserve captured output between an exact command separator and its completion line. */
export function capturedBroadcast(file: string, args?: string): string {
  const lines = fixture(`surface/${file}`).split("\n");
  // bc-noop has no command separator; its entire output is the single broadcast.
  const start = args === undefined ? 0 : lines.indexOf(`$ ${args}`) + 1;
  if (args !== undefined && start === 0) {
    throw new Error(`Missing captured command: ${args}`);
  }
  const end = lines.findIndex((line, i) => i >= start && line.startsWith("Broadcast completed:"));
  if (end < start) {
    throw new Error(`Missing captured reply in ${file}`);
  }
  return lines.slice(start, end + 1).join("\n");
}

export const capturedFace: Pick<ObserveResult, "viewHierarchy"> = JSON.parse(
  fixture("systemtray/ctrlproxy-alert-shy-over-launcher.json"),
);

/** xml2js is the installed XML parser; merge attributes into the hierarchy node contract. */
export async function capturedTile(): Promise<ViewHierarchyResult> {
  return parseStringPromise(fixture("surface/tile0-uiautomator.xml"), {
    explicitArray: false,
    mergeAttrs: true,
  });
}
