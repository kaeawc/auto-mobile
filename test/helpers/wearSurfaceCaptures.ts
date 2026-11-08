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
