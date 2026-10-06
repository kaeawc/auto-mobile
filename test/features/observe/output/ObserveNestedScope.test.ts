import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { ObserveResult } from "../../../../src/models/ObserveResult";
import { ElementResolver } from "../../../../src/features/utility/ElementResolver";
import { SearchableHierarchy } from "../../../../src/features/utility/SearchableNode";
import {
  applyObserveScopeExperiments,
  buildObserveScopeConfig,
} from "../../../../src/features/observe/output/ObserveScopeExperiments";
import { observeSchema, waitForObservation } from "../../../../src/server/observeTools";
import { FakeObserveScreen } from "../../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { finalizeToolResponse } from "../../../../src/server/finalizeToolResponse";
import {
  createStructuredToolResponse,
  getStructuredPayload,
} from "../../../../src/utils/toolUtils";

// Verbatim API 36 widgets capture: repeated headers and shared child IDs, with
// anonymous wrappers. The explicit outer index selects one captured window tree.
const observation: ObserveResult = JSON.parse(
  readFileSync(
    new URL(
      "../../../fixtures/android-launcher/launcher-widgets-emulator-5600.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const pkg = "com.google.android.apps.nexuslauncher:id/";
const outer = { elementId: `${pkg}primary_widgets_list_view`, index: 0 };
const row = { elementId: `${pkg}widgets_list_header`, index: 2, container: outer };
const focus = { elementId: `${pkg}toggle`, container: row, selectionStrategy: "unique" as const };
const flags = { focus: true, overview: true, region: true };
const snapshot = {
  id: "widgets-capture",
  nodes: new SearchableHierarchy().project(observation.viewHierarchy!),
};
function scope(query = focus) {
  return applyObserveScopeExperiments(
    observation,
    buildObserveScopeConfig(flags, { focus: query }),
  );
}
function resolve(query = focus) {
  return new ElementResolver().resolve(snapshot, query, { action: "inspect" });
}

describe("nested observe subtree scope", () => {
  test("schema preserves the recursive selector and rejects malformed chains", () => {
    const parsed = observeSchema.parse({ platform: "android", scope: { focus } });
    expect(parsed.scope?.focus).toEqual(focus);
    expect(
      observeSchema.safeParse({
        platform: "android",
        scope: { focus: { ...focus, container: { elementId: "row", text: "row" } } },
      }).success,
    ).toBe(false);
  });

  test("selects the indexed repeated row's child and reports outer-to-leaf counts", () => {
    const result = scope();
    const chosen = resolve().chosen!;
    expect(result.viewHierarchy?.hierarchy.node).toEqual([chosen.source]);
    expect(snapshot.nodes[chosen.parentIndex!].label).toBe("Battery");
    expect(
      result.observeScope?.focus?.chain?.map(({ selector, matchCount }) => ({
        selector,
        matchCount,
      })),
    ).toEqual([
      { selector: { ...outer, selectionStrategy: "unique" }, matchCount: 2 },
      { selector: { ...row, selectionStrategy: "unique" }, matchCount: 8 },
      { selector: focus, matchCount: 1 },
    ]);
    expect(observation.observeScope).toBeUndefined();
  });

  test("ancestor missing has structured level and byte-identical error text", () => {
    const query = { ...focus, container: { ...row, container: { elementId: "missing" } } };
    const resolved = resolve(query);
    expect(resolved.error).toBe("Container level 1 not found: missing");
    expect(resolved.containerFailure).toEqual({
      level: 1,
      reason: "not-found",
      selector: { elementId: "missing" },
    });
    expect(scope(query).observeScope?.focus?.containerFailure).toEqual(resolved.containerFailure);
    expect(scope(query).observeScope?.focus?.error).toBe(resolved.error);
  });

  test("inner missing retains the matched outer scope and reports level two", () => {
    const query = { ...focus, container: { ...row, elementId: "missing" } };
    const resolved = resolve(query);
    expect(resolved.error).toBe("Container level 2 not found: missing");
    expect(resolved.containerFailure).toMatchObject({
      level: 2,
      reason: "not-found",
      selector: query.container,
    });
    expect(scope(query).observeScope?.focus?.chain).toHaveLength(1);
  });

  test("unique ambiguous leaf reports its count without a container failure", () => {
    const query = { ...focus, elementId: row.elementId, container: outer };
    const result = scope(query);
    expect(result.observeScope?.focus?.error).toStartWith("Target ambiguous:");
    expect(result.observeScope?.focus?.containerFailure).toBeUndefined();
    expect(result.observeScope?.focus?.chain?.at(-1)?.matchCount).toBe(8);
  });

  test("a legacy combined anchor reports the selector that actually matched", () => {
    const result = applyObserveScopeExperiments(
      observation,
      buildObserveScopeConfig(flags, {
        focus: { resourceId: "missing", text: "Battery" },
      }),
    );
    expect(result.observeScope?.focus?.chain).toEqual([
      { selector: { text: "Battery" }, matchCount: 1 },
    ]);
  });

  test("leaf missing inside a resolved chain is distinct", () => {
    const query = { ...focus, elementId: "missing" };
    expect(resolve(query).error).toBe("Target not found within container");
    expect(resolve(query).containerFailure).toBeUndefined();
    expect(scope(query).observeScope?.focus).toMatchObject({
      matched: false,
      error: "Target not found within container",
    });
    expect(scope(query).viewHierarchy?.hierarchy.node).toEqual([]);
  });

  test("unique rejects an ambiguous inner level without changing its message", () => {
    const query = { ...focus, container: { elementId: row.elementId, container: outer } };
    const resolved = resolve(query);
    expect(resolved.error).toStartWith(`Container level 2 ambiguous: ${row.elementId}; `);
    expect(resolved.containerFailure).toEqual({
      level: 2,
      reason: "ambiguous",
      selector: query.container,
    });
    expect(scope(query).observeScope?.focus?.containerFailure).toEqual(resolved.containerFailure);
  });

  test("scope chain and structured failure survive observe wire serialization", () => {
    const render = (query: typeof focus) =>
      finalizeToolResponse(createStructuredToolResponse(observation), {
        name: "observe",
        args: { project: "full", scope: { focus: query } },
      });
    const success = getStructuredPayload<ObserveResult>(render(focus))!;
    expect(success.observeScope?.focus?.chain).toHaveLength(3);
    const failed = render({ ...focus, container: { ...row, container: { elementId: "missing" } } });
    const failedPayload = getStructuredPayload<ObserveResult>(failed)!;
    expect(failedPayload.observeScope?.focus?.containerFailure).toMatchObject({
      level: 1,
      reason: "not-found",
    });
    expect(JSON.parse(failed.content[0].text).observeScope.focus.containerFailure).toEqual(
      failedPayload.observeScope?.focus?.containerFailure,
    );
    const unscoped = finalizeToolResponse(createStructuredToolResponse(observation), {
      name: "observe",
      args: { project: "full" },
    });
    expect(getStructuredPayload<ObserveResult>(unscoped)?.observeScope).toBeUndefined();
    expect(unscoped.content[0].text).not.toContain("containerFailure");
  });

  test("no scope returns the identical observation with no metadata", () => {
    const result = applyObserveScopeExperiments(
      observation,
      buildObserveScopeConfig(flags, undefined),
    );
    expect(result).toBe(observation);
    expect(JSON.stringify(result)).toBe(JSON.stringify(observation));
    expect(result.observeScope).toBeUndefined();
  });

  test("wait settling exposes a container lost after the first match", async () => {
    const home: ObserveResult = JSON.parse(
      readFileSync(
        new URL(
          "../../../fixtures/android-launcher/launcher-home-emulator-5600.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const screen = new FakeObserveScreen();
    screen.setObserveResult((index) => {
      const capture = index < 3 ? observation : home;
      return {
        ...capture,
        updatedAt: index + 1,
        viewHierarchy: { ...capture.viewHierarchy!, updatedAt: index + 1 },
      };
    });
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const outcome = await waitForObservation(
      screen,
      {
        for: "appear",
        elementId: focus.elementId,
        container: row,
        selectionStrategy: "unique",
        timeoutMs: 300,
        settled: { quietPeriodMs: 500 },
      },
      undefined,
      true,
      timer,
      "android",
      "none",
    );
    expect(outcome.matched).toBe(false);
    expect(outcome.containerFailure).toMatchObject({
      level: 1,
      reason: "not-found",
      selector: outer,
    });
  });

  test("a flat legacy positive wait also reports structured container failure", async () => {
    const screen = new FakeObserveScreen();
    screen.setObserveResult(observation);
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const outcome = await waitForObservation(
      screen,
      { elementId: focus.elementId, container: { elementId: "missing" }, timeoutMs: 0 },
      undefined,
      true,
      timer,
      "android",
      "none",
    );
    expect(outcome.containerFailure).toMatchObject({ level: 1, reason: "not-found" });
  });

  for (const dsl of [false, true]) {
    test(`observe waitFor ${dsl ? "DSL" : "legacy scoped"} exposes the resolver failure`, async () => {
      const screen = new FakeObserveScreen();
      screen.setObserveResult(observation);
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const outcome = await waitForObservation(
        screen,
        {
          ...(dsl ? { for: "appear" as const } : {}),
          elementId: focus.elementId,
          container: { elementId: "missing" },
          selectionStrategy: "unique",
          timeoutMs: 0,
        },
        undefined,
        true,
        timer,
        "android",
        "none",
      );
      expect(outcome.timedOut).toBe(true);
      expect(JSON.parse(JSON.stringify(outcome.containerFailure))).toEqual({
        level: 1,
        reason: "not-found",
        selector: { elementId: "missing", ...(dsl ? {} : { selectionStrategy: "unique" }) },
      });
      expect(outcome.timeoutReason).toContain("Container level 1 not found: missing");
    });
  }
});
