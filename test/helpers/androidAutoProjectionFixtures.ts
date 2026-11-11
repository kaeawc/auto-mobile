import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ANDROID_AUTO_PACKAGE,
  CAR_APP_PROJECTED_NOTE,
  CAR_APP_TEMPLATES_NOTE,
  carAppTemplateDocumentSchema,
  type CarAppProjectedTemplates,
} from "../../src/models/CarAppTemplates";

/**
 * Android Auto projection fixtures (#17826), captured verbatim on 2026-11-10 from a
 * `google_apis_playstore` API 36 arm64 emulator with no Google account, Android Auto 18.1.664404
 * projecting to a headless DHU 2.1, and the automotive fixture app open:
 * - `services-one-bound.txt`: `adb shell dumpsys activity services` while the fixture's List
 *   template is shown on the head unit. The fixture's `FixtureCarAppService` is bound by
 *   `com.google.android.projection.gearhead:projection`; the bind intent carries no
 *   `androidx.car.app.CarAppService` action.
 * - `services-none-bound.txt`: the same command after projection ended and Android Auto and the
 *   fixture were force-stopped.
 * - `fixture-list-bundle.txt`: `adb shell content call --user 0 --uri
 *   content://<fixture>.automobile.carapptemplates --method snapshot` during the same projection.
 * No host path appears in any of them.
 */
const FIXTURE_DIR = join(import.meta.dir, "..", "fixtures", "android-auto-projection");

export type ProjectionServicesFixture = "none" | "one";

export function projectionServicesDump(bound: ProjectionServicesFixture): string {
  return readFileSync(join(FIXTURE_DIR, `services-${bound}-bound.txt`), "utf8");
}

/** The captured `content call` output wrapping the fixture's route document. */
export function fixtureListBundle(): string {
  return readFileSync(join(FIXTURE_DIR, "fixture-list-bundle.txt"), "utf8");
}

/** The route document inside {@link fixtureListBundle}. */
export function fixtureListSnapshot(): unknown {
  const match = /^Result: Bundle\[\{result=(.*)\}\]\s*$/s.exec(fixtureListBundle());
  if (!match) {
    throw new Error("fixture-list-bundle.txt is not a content call Bundle");
  }
  return JSON.parse(match[1]);
}

/** `adb shell content call` output wrapping a route document. */
export function contentCallBundle(document: unknown): string {
  return `Result: Bundle[{result=${JSON.stringify(document)}}]`;
}

/**
 * The captured fixture's snapshot as observe's projected block, so head-unit tests read the live
 * capture. `depth` keeps that many screens from the root: 1 is the fixture's TemplateMenuScreen
 * before the List template row was opened, 2 (the capture) has ListScreen on top.
 */
export function fixtureProjectedTemplates(depth = 2): CarAppProjectedTemplates {
  const document = carAppTemplateDocumentSchema.parse(fixtureListSnapshot());
  return {
    source: "sdk",
    note: CAR_APP_TEMPLATES_NOTE,
    projectedBy: ANDROID_AUTO_PACKAGE,
    projectedNote: CAR_APP_PROJECTED_NOTE,
    projected: [
      {
        packageName: FIXTURE_CAR_APP_PACKAGE,
        sessions: document.sessions.map((session) => {
          const screens = session.screens.slice(0, depth);
          return {
            ...session,
            screens: screens.map((screen, index) => ({
              ...screen,
              top: index === screens.length - 1,
            })),
          };
        }),
      },
    ],
  };
}

/** The automotive fixture app the captures were taken with. */
export const FIXTURE_CAR_APP_PACKAGE = "dev.jasonpearson.automobile.automotivefixture";
