import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { finalizeToolResponse } from "../../src/server/finalizeToolResponse";
import { createStructuredToolResponse, getStructuredPayload } from "../../src/utils/toolUtils";
import { serverConfig } from "../../src/utils/ServerConfig";
import { DefaultObserveElementCollector } from "../../src/features/observe/ObserveElementCollector";
import type { ObserveResult } from "../../src/models/ObserveResult";
import type { FinalizeToolResponseContext } from "../../src/server/finalizeToolResponse";

// #18348: on 0.0.94 tapOn still returned `element` beside an identical
// `selectedElement.matchedElement`, and a no-op tapOn repeated the whole skeleton.

function fixture<T>(path: string): T {
  return JSON.parse(readFileSync(new URL(`../fixtures/${path}`, import.meta.url), "utf8"));
}

/** A delivered headset tapOn result, captured verbatim (#17798). */
const capturedTap = fixture<{ tapOnLauncherButton: Record<string, any> }>(
  "android-xr/tapon-launcher-button-no-effect-17798.json",
).tapOnLauncherButton;

/** A real Settings screen with skeleton and context rows (#17464). */
const settings = fixture<ObserveResult>("android-settings/open-by-default-radio-rows.observe.json");

type Payload = Record<string, any>;
type Node = Record<string, unknown> & { node?: Node | Node[] };

/** The tap as the handler built it: `element` is the same captured node `matchedElement` names. */
function tapWithElement(): Payload {
  const tap = structuredClone(capturedTap);
  return { ...tap, element: structuredClone(tap.selectedElement.matchedElement) };
}

function deliver(payload: Payload, ctx: Partial<FinalizeToolResponseContext> = {}): Payload {
  return getStructuredPayload<Payload>(
    finalizeToolResponse(createStructuredToolResponse(payload), {
      name: "tapOn",
      defaultsToSkeletonObservation: true,
      ...ctx,
    }),
  )!;
}

function makeStore() {
  const map = new Map<string, ObserveResult>();
  const metadata = new Map<string, Record<string, unknown>>();
  return {
    get: (u: string) => map.get(u),
    set: (u: string, o: ObserveResult) => void map.set(u, o),
    getActionMetadata: (u: string) => metadata.get(u),
    setActionMetadata: (u: string, _d: string, blocks: Record<string, unknown>) =>
      void metadata.set(u, blocks),
  };
}

describe("#18348 tapOn carries one copy of the tapped node", () => {
  let compact: boolean;
  beforeEach(() => {
    compact = serverConfig.isActionsCompactMetadataEnabled();
  });
  afterEach(() => serverConfig.setActionsCompactMetadataEnabled(compact));

  test("without a session or baseline store", () => {
    const out = deliver(tapWithElement());

    expect(out).not.toHaveProperty("element");
    expect(out.selectedElement.matchedElement).toEqual(capturedTap.selectedElement.matchedElement);
  });

  test("with actions-compact-metadata off", () => {
    serverConfig.setActionsCompactMetadataEnabled(false);
    const out = deliver(tapWithElement(), { sessionUuid: "s1", baselineStore: makeStore() });

    expect(out).not.toHaveProperty("element");
  });

  test("when one read reports an empty label the other omits", () => {
    const tap = tapWithElement();
    tap.element["content-desc"] = "";

    expect(deliver(tap)).not.toHaveProperty("element");
  });

  test("a different promoted node, an internal call and a failure keep element", () => {
    const promoted = tapWithElement();
    promoted.element["resource-id"] = "com.android.systemui:id/launcher_container";
    expect(deliver(promoted).element).toEqual(promoted.element);

    expect(deliver(tapWithElement(), { internal: true })).toHaveProperty("element");
    expect(deliver({ ...tapWithElement(), success: false, error: "x" })).toHaveProperty("element");
  });
});

function observation(mutate?: (copy: ObserveResult) => void): ObserveResult {
  const copy: ObserveResult = structuredClone(settings);
  mutate?.(copy);
  return {
    ...copy,
    elements: new DefaultObserveElementCollector().collect(copy.viewHierarchy!, "android"),
  };
}

/** The node whose children include the row reading `text`; `node` is normalized to an array. */
function findParentOf(root: unknown, text: string): Node[] | undefined {
  if (Array.isArray(root)) {
    for (const child of root) {
      const found = findParentOf(child, text);
      if (found) {
        return found;
      }
    }
    return undefined;
  }
  if (!root || typeof root !== "object") {
    return undefined;
  }
  const node = root as Node & { hierarchy?: unknown };
  if (node.hierarchy !== undefined) {
    return findParentOf(node.hierarchy, text);
  }
  if (node.node === undefined) {
    return undefined;
  }
  if (!Array.isArray(node.node)) {
    node.node = [node.node];
  }
  const children = node.node;
  return children.some((child) => child.text === text) ? children : findParentOf(children, text);
}

/** The no-op `tapOn {ensureChecked: true}` from the issue, against an unchanged screen. */
function noOpTap(mutateNext?: (copy: ObserveResult) => void): Payload {
  const store = makeStore();
  finalizeToolResponse(createStructuredToolResponse(observation()), {
    name: "observe",
    sessionUuid: "s1",
    baselineStore: store,
  });
  return deliver(
    {
      success: true,
      message: "In the app already checked, no tap",
      skipped: "already-checked",
      effect: { screenChanged: false, basis: "viewHierarchy unchanged" },
      observation: observation(mutateNext),
    },
    { sessionUuid: "s1", baselineStore: store },
  );
}

describe("#18348 a no-op action diff does not restate the screen", () => {
  let diffEnabled: boolean;
  beforeEach(() => {
    diffEnabled = serverConfig.isActionsDiffObserveEnabled();
    serverConfig.setActionsDiffObserveEnabled(true);
  });
  afterEach(() => serverConfig.setActionsDiffObserveEnabled(diffEnabled));

  test("an unchanged screen answers unchanged: true without skeleton or context", () => {
    const out = noOpTap();

    expect(out.observationDiff).toMatchObject({ mode: "diff", reason: "diff_emitted" });
    expect(out.observation).toMatchObject({ isDiff: true, unchanged: true, changed: [] });
    expect(out.observation).not.toHaveProperty("skeleton");
    expect(out.observation).not.toHaveProperty("context");
    expect(out.observation.observationId).toBe(settings.observationId);
  });

  test("a changed readout keeps the skeleton and context", () => {
    // The projected diff shows a readout change only through `context`.
    const out = noOpTap((copy) => {
      const rows = findParentOf(copy.viewHierarchy, "Links to open in this app")!;
      rows.find((row) => row.text === "Links to open in this app")!.text = "Links to open here";
    });

    expect(out.observation.isDiff).toBe(true);
    expect(out.observation.unchanged).toBeUndefined();
    expect(out.observation.skeleton.length).toBeGreaterThan(0);
    expect(out.observation.context.map((row: { label: string }) => row.label)).toContain(
      "Links to open here",
    );
  });

  test("a new non-actionable row the projected diff drops still keeps the skeleton", () => {
    const out = noOpTap((copy) => {
      const rows = findParentOf(copy.viewHierarchy, "0 verified links")!;
      const row = rows.find((candidate) => candidate.text === "0 verified links")!;
      rows.push({
        ...structuredClone(row),
        text: "1 verified link",
        bounds: [63, 1612, 400, 1683],
      });
    });

    expect(out.observation.isDiff).toBe(true);
    expect(out.observation.unchanged).toBeUndefined();
    expect(out.observation.skeleton.length).toBeGreaterThan(0);
  });
});
