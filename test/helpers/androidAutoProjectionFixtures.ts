import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Android Auto projection fixtures (#17826). The route reply carries the fields the #16750 live-DHU
 * capture shows (session2, TemplateMenuScreen below a top ListScreen titled "List template"); that
 * capture was truncated, so the remaining template fields are empty. The services dumps follow the
 * API 36 `dumpsys activity services` ServiceRecord layout with host paths replaced; they are not a
 * verbatim capture.
 */
const FIXTURE_DIR = join(import.meta.dir, "..", "fixtures", "android-auto-projection");

export type ProjectionServicesFixture = "none" | "one" | "two";

export function projectionServicesDump(bound: ProjectionServicesFixture): string {
  return readFileSync(join(FIXTURE_DIR, `services-${bound}-bound.txt`), "utf8");
}

/** The automotive fixture's route document while the DHU shows its List template. */
export function fixtureListSnapshot(): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, "fixture-list-snapshot.json"), "utf8"));
}

/** `adb shell content call` output wrapping a route document. */
export function contentCallBundle(document: unknown): string {
  return `Result: Bundle[{result=${JSON.stringify(document)}}]`;
}
