import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseInputGestureParams,
  parseInputKeyParams,
  parseInputPressButtonParams,
  parseInputSwipeParams,
  parseInputTapParams,
  parseInputTypeTextParams,
} from "../../src/daemon/inputRouteParams";
import { INPUT_ROUTES } from "../../src/daemon/inputRoutes";
import { inputRouteParamCases } from "./helpers/inputRouteParamCases";

/**
 * #11813: the `input/*` param schemas reproduce the hand-written parsers exactly. The golden file
 * was captured from those parsers (refusal message or parsed shape for every case), so any drift
 * in refusal text, check order or output shape fails here.
 */

interface Golden {
  route: string;
  label: string;
  ok: boolean;
  value?: unknown;
  message?: string;
}

const golden = JSON.parse(
  readFileSync(join(import.meta.dir, "../fixtures/input-route-params/golden.json"), "utf8"),
) as Golden[];
const cases = inputRouteParamCases();

const parsers: Record<string, (params: unknown) => unknown> = {
  "input/tap": parseInputTapParams,
  "input/swipe": parseInputSwipeParams,
  "input/typeText": parseInputTypeTextParams,
  "input/pressButton": parseInputPressButtonParams,
  "input/key": parseInputKeyParams,
};

function run(route: string, params: unknown): Pick<Golden, "ok" | "value" | "message"> {
  const parse = parsers[route] ?? ((p: unknown) => parseInputGestureParams(p, route));
  try {
    return { ok: true, value: JSON.parse(JSON.stringify(parse(params))) };
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
}

describe("input/* route param schemas match the captured parsers (#11813)", () => {
  test("the goldens cover exactly the case matrix", () => {
    expect(golden.map((entry) => `${entry.route}|${entry.label}`)).toEqual(
      cases.map((entry) => `${entry.route}|${entry.label}`),
    );
  });

  test("every input route has valid and refused goldens", () => {
    for (const route of INPUT_ROUTES) {
      const entries = golden.filter((entry) => entry.route === route.method);
      expect(entries.some((entry) => entry.ok)).toBe(true);
      expect(entries.some((entry) => !entry.ok)).toBe(true);
    }
  });

  test.each(cases.map((entry, index) => [`${entry.route} ${entry.label}`, index] as const))(
    "%s",
    (_name, index) => {
      const expected = golden[index];
      const actual = run(cases[index].route, cases[index].params);
      expect(actual.ok).toBe(expected.ok);
      expect(actual.message).toBe(expected.message);
      expect(actual.value).toEqual(expected.value);
    },
  );
});
