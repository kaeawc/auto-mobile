import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { finalizeToolResponse } from "../../src/server/finalizeToolResponse";
import { createStructuredToolResponse, getStructuredPayload } from "../../src/utils/toolUtils";
import { serverConfig } from "../../src/utils/ServerConfig";
import { DefaultObserveElementCollector } from "../../src/features/observe/ObserveElementCollector";
import type { ObserveResult } from "../../src/models/ObserveResult";

// Real emulator capture (Settings > Open by default, 1080x2424) including the
// com.android.systemui status bar ("T-Mobile, two bars.").
const capture: ObserveResult = JSON.parse(
  readFileSync(
    new URL(
      "../fixtures/android-settings/open-by-default-radio-rows.observe.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

type Mutable = Record<string, unknown>;

function visit(node: unknown, fn: (n: Mutable) => void): void {
  if (Array.isArray(node)) {
    node.forEach((n) => visit(n, fn));
  } else if (node && typeof node === "object") {
    fn(node as Mutable);
    Object.values(node).forEach((n) => visit(n, fn));
  }
}

function observation(mutate?: (root: unknown) => void): ObserveResult {
  const copy: ObserveResult = structuredClone(capture);
  mutate?.(copy.viewHierarchy);
  return {
    ...copy,
    elements: new DefaultObserveElementCollector().collect(copy.viewHierarchy!, "android"),
  };
}

function makeStore() {
  const map = new Map<string, ObserveResult>();
  const metadata = new Map<string, { deviceId: string; blocks: Record<string, unknown> }>();
  return {
    get: (u: string) => map.get(u),
    set: (u: string, o: ObserveResult) => void map.set(u, o),
    getActionMetadata: (u: string, deviceId: string) =>
      metadata.get(u)?.deviceId === deviceId ? metadata.get(u)?.blocks : undefined,
    setActionMetadata: (u: string, deviceId: string, blocks: Record<string, unknown>) =>
      void metadata.set(u, { deviceId, blocks }),
  };
}

let original: boolean;
beforeEach(() => {
  original = serverConfig.isActionsDiffObserveEnabled();
  serverConfig.setActionsDiffObserveEnabled(true);
});
afterEach(() => serverConfig.setActionsDiffObserveEnabled(original));

function tapOn(next: ObserveResult, extra: Record<string, unknown> = {}): Record<string, any> {
  const store = makeStore();
  finalizeToolResponse(createStructuredToolResponse(observation()), {
    name: "observe",
    sessionUuid: "s1",
    baselineStore: store,
  });
  const out = getStructuredPayload<Record<string, any>>(
    finalizeToolResponse(
      createStructuredToolResponse({ success: true, ...extra, observation: next }),
      {
        name: "tapOn",
        sessionUuid: "s1",
        baselineStore: store,
      },
    ),
  );
  return out!;
}

function signalBars(desc: string) {
  return (root: unknown) =>
    visit(root, (n) => {
      if (n["resource-id"] === "com.android.systemui:id/mobile_combo") {
        n["content-desc"] = desc;
      }
    });
}

const tapMatch = {
  elementId: "android:id/checkbox",
  label: "In your browser",
  bounds: [53, 1244, 137, 1328],
  actions: ["ACTION_CLICK", "ACTION_FOCUS"],
};

test("#11637 item 5: a status-bar signal-strength change is not a screen change", () => {
  const out = tapOn(observation(signalBars("T-Mobile, one bar.")));

  expect(out.observation.isDiff).toBe(true);
  expect(out.observation.changed).toEqual([]);
  expect(out.observation.added).toEqual([]);
  expect(out.observation.removed).toEqual([]);
});

test("#11637 item 5: app changes still diff next to a status-bar change", () => {
  const out = tapOn(
    observation((root) => {
      signalBars("T-Mobile, one bar.")(root);
      visit(root, (n) => {
        if (n["resource-id"] === "android:id/checkbox" && n.checked === "true") {
          n.checked = "false";
        }
      });
    }),
  );

  const ids = out.observation.changed.map((c: any) => c.selector.elementId);
  expect(ids).toContain("android:id/checkbox");
  expect(ids.some((id: string) => id.startsWith("com.android.systemui:"))).toBe(false);
});

test("#11637 item 4: element is not repeated as selectedElement.matchedElement", () => {
  const out = tapOn(observation(), {
    element: tapMatch,
    selectedElement: { matchedElement: structuredClone(tapMatch), strategy: "text" },
  });

  expect(out.selectedElement.matchedElement).toEqual(tapMatch);
  expect(out.element).toBeUndefined();
});

test("#11637 item 2: added/removed carry only actionable nodes beside the skeleton", () => {
  const out = tapOn(
    observation((root) =>
      visit(root, (n) => {
        if (n["resource-id"] === "android:id/checkbox" && n.checked === "true") {
          n.checked = "false";
        }
      }),
    ),
  );

  const diff = out.observation;
  expect(diff.skeleton.length).toBeGreaterThan(0);
  for (const node of [...diff.added, ...diff.removed]) {
    expect(node.attributes.affordances.length).toBeGreaterThan(0);
  }
});
