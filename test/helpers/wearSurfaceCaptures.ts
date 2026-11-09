import { readFileSync } from "node:fs";
import path from "node:path";
import { parseStringPromise } from "xml2js";
import type { ObserveResult, ViewHierarchyResult } from "../../src/models";
import { buildObserveResult } from "./observeFixture";

const fixtures = path.join(import.meta.dir, "../fixtures/wear");
const fixture = (name: string) => readFileSync(path.join(fixtures, name), "utf8");

/** Full-projection captures contain just the foreground window and hierarchy. */
export function capturedSurfaceObservation(name: "tile-showing" | "app-in-front"): ObserveResult {
  const capture: Pick<ObserveResult, "activeWindow" | "viewHierarchy"> = JSON.parse(
    fixture(`surface/observe-full-${name}.json`),
  );
  return buildObserveResult({
    updatedAt: 0,
    screenSize: { width: 454, height: 454 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    ...capture,
  });
}

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
