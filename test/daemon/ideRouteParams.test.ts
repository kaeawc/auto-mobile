import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ideRouteParamCases, runIdeParamCase } from "./helpers/ideRouteParamCases";

/**
 * #11813: what each `ide/*` route does with its params, pinned before the checks move into
 * schemas. The goldens were captured from the hand-written checks: the route's refusal text for
 * an invalid case, or the step it reached (`PAST_CHECK`) and with what for a valid one.
 */

interface Golden {
  route: string;
  label: string;
  outcome: string;
}

const golden = JSON.parse(
  readFileSync(join(import.meta.dir, "../fixtures/ide-route-params/golden.json"), "utf8"),
) as Golden[];
const cases = ideRouteParamCases();

describe("ide/* route params handling", () => {
  test("the goldens cover exactly the case matrix", () => {
    expect(golden.map((entry) => `${entry.route}|${entry.label}`)).toEqual(
      cases.map((entry) => `${entry.route}|${entry.label}`),
    );
  });

  test("every route has a case that passes its check and cases it refuses", () => {
    for (const route of new Set(cases.map((entry) => entry.route))) {
      const outcomes = golden
        .filter((entry) => entry.route === route)
        .map((entry) => entry.outcome);
      expect(outcomes.some((outcome) => outcome.startsWith("PAST_CHECK"))).toBe(true);
      expect(outcomes.some((outcome) => !outcome.startsWith("PAST_CHECK"))).toBe(true);
    }
  });

  test.each(cases.map((entry, index) => [`${entry.route} ${entry.label}`, index] as const))(
    "%s",
    async (_name, index) => {
      expect(await runIdeParamCase(cases[index])).toBe(golden[index].outcome);
    },
  );
});
