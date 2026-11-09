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

/**
 * The lines under an exact `== <label>` header of a captured watch-face run, up to the next
 * header or blank line: the broadcast reply and any readback grep the capture printed.
 */
export function capturedSection(file: string, label: string): string[] {
  const lines = fixture(`surface/${file}`).split("\n");
  const start = lines.indexOf(`== ${label}`) + 1;
  if (start === 0) {
    throw new Error(`Missing captured section: ${label}`);
  }
  const rest = lines.slice(start);
  const end = rest.findIndex((line) => line.startsWith("== ") || line === "");
  return end < 0 ? rest : rest.slice(0, end);
}

/**
 * #17520 printed each reply as `<command> -> result=<n>, data="<text>"` without am's
 * `Broadcast completed: ` prefix; return the line's reply in am's own format.
 */
export function capturedArrowReply(command: string): string {
  const matches = fixture("surface/complication-replies.txt")
    .split("\n")
    .filter((line) => line.split(" -> ")[0]?.trimEnd() === command);
  if (matches.length !== 1) {
    throw new Error(`Expected one captured reply for: ${command}`);
  }
  return `Broadcast completed: ${matches[0]?.split(" -> ")[1]}`;
}

/** `<run> | <reply> | <readback>` lines of a captured repeat run, split into their columns. */
export function capturedRuns(
  file: string,
): Array<{ run: string; reply: string; readback: string }> {
  return fixture(`surface/${file}`)
    .split("\n")
    .filter((line) => line.startsWith("run"))
    .map((line) => {
      const [run = "", reply = "", readback = ""] = line.split(" | ");
      return { run, reply, readback };
    });
}

/** A whole raw `dumpsys wear_service` capture (Offhand active, favorite 1). */
export function capturedWearService(name = "interactive-watch-face.txt"): string {
  return fixture(`wear-service/${name}`);
}

const ACTIVE_LINE = /^activeWatchFaceComponent=WatchFaceId\[([^,\]]+),null\]/m;
const FAVORITE_LINE = /favoriteId=(\d+)/;
const CONFIG_LINE = /^\s*id=\d+ slot=(\d+) .*$/m;

/**
 * The #17520 captures grepped only the changed lines out of each `dumpsys wear_service`
 * readback. Splice them into the whole Offhand capture so `parseWatchFaces` reads them in place:
 * an active-face excerpt replaces the active component (and its favorite id, which an excerpt
 * without one drops), and a live config excerpt replaces that slot's config line.
 */
export function capturedReadback(excerpt: string): string {
  let dumpsys = capturedWearService();
  const face = ACTIVE_LINE.exec(excerpt);
  if (face) {
    const favorite = FAVORITE_LINE.exec(excerpt)?.[1];
    dumpsys = dumpsys
      .replace(
        /^activeWatchFaceComponent=.*$/m,
        `activeWatchFaceComponent=WatchFaceId[${face[1]},null]`,
      )
      .replace(/^favoriteId=\d+\n/m, favorite === undefined ? "" : `favoriteId=${favorite}\n`);
    if (favorite !== undefined) {
      dumpsys = dumpsys.replace(
        /mWatchFaceId=WatchFaceId\[[^\]]*\], mFavoriteId=\d+/,
        `mWatchFaceId=WatchFaceId[${face[1]},null], mFavoriteId=${favorite}`,
      );
    }
  }
  const config = CONFIG_LINE.exec(excerpt);
  if (config) {
    dumpsys = dumpsys.replace(
      new RegExp(String.raw`^\s*id=\d+ slot=${config[1]} .*$`, "m"),
      config[0],
    );
  }
  return dumpsys;
}
