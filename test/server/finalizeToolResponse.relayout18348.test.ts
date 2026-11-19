import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { finalizeToolResponse } from "../../src/server/finalizeToolResponse";
import { createStructuredToolResponse, getStructuredPayload } from "../../src/utils/toolUtils";
import { serverConfig } from "../../src/utils/ServerConfig";
import { DefaultObserveElementCollector } from "../../src/features/observe/ObserveElementCollector";
import type { ObserveResult } from "../../src/models/ObserveResult";

// #18348 item 4: a keyboard swap moved a dialog 27 px and the projected diff
// listed every moved control as a bounds-only `changed` row.

/** A real Settings screen with actionable radio rows (#17464). */
const settings: ObserveResult = JSON.parse(
  readFileSync(
    new URL(
      "../fixtures/android-settings/open-by-default-radio-rows.observe.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

type Payload = Record<string, any>;
type Node = Record<string, unknown> & { node?: Node | Node[] };

/** Visit every hierarchy node below `root`. */
function eachNode(root: unknown, visit: (node: Node) => void): void {
  if (Array.isArray(root)) {
    root.forEach((child) => eachNode(child, visit));
    return;
  }
  if (!root || typeof root !== "object") {
    return;
  }
  const node = root as Node & { hierarchy?: unknown };
  if (node.hierarchy !== undefined) {
    eachNode(node.hierarchy, visit);
    return;
  }
  visit(node);
  eachNode(node.node, visit);
}

/** Every node below the window root moved down by `dy`, as the time-picker dialog did. */
function shiftedBy(dy: number) {
  return (copy: ObserveResult) =>
    eachNode(copy.viewHierarchy, (node) => {
      const bounds = node.bounds;
      if (Array.isArray(bounds) && bounds.length === 4 && bounds[1] !== 0) {
        node.bounds = [bounds[0], bounds[1] + dy, bounds[2], bounds[3] + dy];
      }
    });
}

function observation(mutate?: (copy: ObserveResult) => void): ObserveResult {
  const copy: ObserveResult = structuredClone(settings);
  mutate?.(copy);
  return {
    ...copy,
    elements: new DefaultObserveElementCollector().collect(copy.viewHierarchy!, "android"),
  };
}

function actionAfter(mutateNext: (copy: ObserveResult) => void): Payload {
  const map = new Map<string, ObserveResult>();
  const store = {
    get: (u: string) => map.get(u),
    set: (u: string, o: ObserveResult) => void map.set(u, o),
  };
  finalizeToolResponse(createStructuredToolResponse(observation()), {
    name: "observe",
    sessionUuid: "s1",
    baselineStore: store,
  });
  return getStructuredPayload<Payload>(
    finalizeToolResponse(
      createStructuredToolResponse({
        success: true,
        message: "Typed",
        observation: observation(mutateNext),
      }),
      {
        name: "sendKeys",
        sessionUuid: "s1",
        baselineStore: store,
        defaultsToSkeletonObservation: true,
      },
    ),
  )!;
}

describe("#18348 bounds-only moves of unchanged controls", () => {
  let diffEnabled: boolean;
  beforeEach(() => {
    diffEnabled = serverConfig.isActionsDiffObserveEnabled();
    serverConfig.setActionsDiffObserveEnabled(true);
  });
  afterEach(() => serverConfig.setActionsDiffObserveEnabled(diffEnabled));

  test("are summed up in one relayout line instead of changed rows", () => {
    const out = actionAfter(shiftedBy(27));

    expect(out.observation.isDiff).toBe(true);
    expect(out.observation.changed).toEqual([]);
    expect(out.observation.relayout.count).toBeGreaterThan(0);
    expect(out.observation.relayout).toMatchObject({ dy: 27 });
    expect(out.observation.relayout).not.toHaveProperty("dx");
    // The skeleton still ships, with the new positions.
    expect(out.observation.unchanged).toBeUndefined();
    expect(out.observation.skeleton.length).toBeGreaterThan(0);
  });

  test("a state change with no move stays in changed, with no relayout", () => {
    const out = actionAfter((copy) =>
      eachNode(copy.viewHierarchy, (node) => {
        if (node["resource-id"] === "android:id/checkbox") {
          node.checked = node.checked === "true" ? "false" : "true";
        }
      }),
    );

    const changed: Array<{ changes: Record<string, unknown> }> = out.observation.changed;
    expect(changed.filter((entry) => "checked" in entry.changes).length).toBe(2);
    expect(out.observation).not.toHaveProperty("relayout");
  });

  test("moves with different offsets omit dy", () => {
    let moved = 0;
    const out = actionAfter((copy) =>
      eachNode(copy.viewHierarchy, (node) => {
        const bounds = node.bounds;
        if (Array.isArray(bounds) && bounds.length === 4 && bounds[1] !== 0) {
          moved += 1;
          const dy = moved % 2 === 0 ? 20 : 10;
          node.bounds = [bounds[0], bounds[1] + dy, bounds[2], bounds[3] + dy];
        }
      }),
    );

    expect(
      out.observation.changed.filter(
        (entry: { changes: Record<string, unknown> }) =>
          Object.keys(entry.changes).join() === "bounds",
      ),
    ).toEqual([]);
    expect(out.observation.relayout.count).toBeGreaterThan(0);
    expect(out.observation.relayout).not.toHaveProperty("dy");
  });
});
