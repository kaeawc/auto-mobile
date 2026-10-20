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
const ENGINE_TYPE_ERROR = /is not an object \(evaluating /;

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

  test("only the nullish-params cases ever surfaced the engine TypeError", () => {
    const engine = golden.filter((entry) => ENGINE_TYPE_ERROR.test(entry.outcome));
    expect(engine).toHaveLength(12);
    expect(engine.every((entry) => /^params (undefined|null)$/.test(entry.label))).toBe(true);
  });

  test.each(cases.map((entry, index) => [`${entry.route} ${entry.label}`, index] as const))(
    "%s",
    async (_name, index) => {
      const { route, outcome } = golden[index];
      // The one deliberate difference: nullish params used to surface the engine's TypeError
      // (not a contract); they now get the route's own refusal, exactly as an empty object does.
      const expected = ENGINE_TYPE_ERROR.test(outcome)
        ? golden.find((entry) => entry.route === route && entry.label === "empty object")!.outcome
        : outcome;
      expect(await runIdeParamCase(cases[index])).toBe(expected);
    },
  );
});
