import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ActiveWindowInfo } from "../../src/models/ActiveWindowInfo";
import type { ObserveResult } from "../../src/models/ObserveResult";
import type { ViewHierarchyNode } from "../../src/models/ViewHierarchyResult";
import { HOST_RESOURCE_ID_PREFIX } from "../../src/features/observe/automotive/carAppHostRenderedUi";
import { buildObserveResult } from "./observeFixture";

/** Trimmed `observe --project full` captures from #16744 / #17498 (AAOS API 34 ext9, userdebug). */
export type CarAppTemplateFixture =
  | "menu"
  | "list"
  | "grid"
  | "pane"
  | "navigation-place-list"
  | "list-driving";

interface TrimmedNode {
  id: string;
  text: string | null;
  desc: string | null;
  click: string | null;
  bounds: [number, number, number, number];
}

interface TrimmedCapture {
  activeWindow: ActiveWindowInfo;
  nodes: TrimmedNode[];
}

const FIXTURE_DIR = join(import.meta.dir, "..", "fixtures", "automotive", "car-app-templates");

function isTrimmedCapture(value: unknown): value is TrimmedCapture {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.activeWindow === "object" && Array.isArray(record.nodes);
}

/** The capture abbreviates the templates-host id prefix to `host:`; expand it back. */
function toNode(trimmed: TrimmedNode): ViewHierarchyNode {
  const [left, top, right, bottom] = trimmed.bounds;
  const node: ViewHierarchyNode = {
    "resource-id": trimmed.id.startsWith("host:")
      ? `${HOST_RESOURCE_ID_PREFIX}${trimmed.id.slice("host:".length)}`
      : trimmed.id,
    bounds: { left, top, right, bottom },
  };
  if (trimmed.text !== null) {
    node.text = trimmed.text;
  }
  if (trimmed.desc !== null) {
    node["content-desc"] = trimmed.desc;
  }
  if (trimmed.click !== null) {
    node.clickable = trimmed.click;
  }
  return node;
}

/** Loads a committed capture as an `ObserveResult` with a flat tree under one root. */
export function carAppTemplateObservation(
  name: CarAppTemplateFixture,
  overrides: { activityName?: string; updatedAt?: number } = {},
): ObserveResult {
  const raw: unknown = JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.json`), "utf8"));
  if (!isTrimmedCapture(raw)) {
    throw new Error(`${name}.json is not a trimmed Car App template capture`);
  }
  return buildObserveResult({
    updatedAt: overrides.updatedAt ?? 1,
    screenSize: { width: 1024, height: 768 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    activeWindow: {
      ...raw.activeWindow,
      activityName: overrides.activityName ?? raw.activeWindow.activityName,
    },
    viewHierarchy: {
      packageName: raw.activeWindow.appId,
      hierarchy: {
        node: {
          bounds: { left: 0, top: 0, right: 1024, bottom: 768 },
          node: raw.nodes.map(toNode),
        },
      },
    },
  });
}
