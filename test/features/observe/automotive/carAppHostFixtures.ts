import { readFileSync } from "node:fs";
import type { ObserveResult, ViewHierarchyNode } from "../../../../src/models";
import { CAR_APP_TEMPLATES_HOST_PACKAGE } from "../../../../src/features/observe/automotive/carAppHostRenderedUi";

/** Trimmed `observe --project full` captures from #16744 (API 34 ext9 AAOS, non-systemui nodes). */
export const CAR_APP_HOST_FIXTURES = [
  "menu",
  "list",
  "grid",
  "pane",
  "navigation-place-list",
  "list-driving",
] as const;

export type CarAppHostFixtureName = (typeof CAR_APP_HOST_FIXTURES)[number];

interface FixtureNode {
  id: string;
  text: string | null;
  desc: string | null;
  click: string | null;
  bounds: [number, number, number, number];
}

interface CarAppHostFixture {
  activeWindow: NonNullable<ObserveResult["activeWindow"]>;
  automotive: NonNullable<ObserveResult["automotive"]>;
  nodes: FixtureNode[];
}

export function readCarAppHostFixture(name: CarAppHostFixtureName): CarAppHostFixture {
  return JSON.parse(
    readFileSync(
      new URL(`../../../fixtures/automotive/car-app-host-templates/${name}.json`, import.meta.url),
      "utf8",
    ),
  ) as CarAppHostFixture;
}

/** The capture abbreviates the host's `<package>:id/` resource-id prefix as `host:`. */
function resourceId(id: string): string {
  return id.startsWith("host:") ? `${CAR_APP_TEMPLATES_HOST_PACKAGE}:id/${id.slice(5)}` : id;
}

function toNode({ id, text, desc, click, bounds: [left, top, right, bottom] }: FixtureNode) {
  return {
    "resource-id": resourceId(id),
    ...(text !== null ? { text } : {}),
    ...(desc !== null ? { "content-desc": desc } : {}),
    ...(click !== null ? { clickable: click } : {}),
    bounds: { left, top, right, bottom },
  } satisfies ViewHierarchyNode;
}

/** The fixture's nodes as one flat CtrlProxy-shaped hierarchy under an unnamed root. */
export function fixtureHierarchy(
  fixture: Pick<CarAppHostFixture, "activeWindow" | "nodes">,
): NonNullable<ObserveResult["viewHierarchy"]> {
  return {
    packageName: fixture.activeWindow.appId,
    hierarchy: { node: { node: fixture.nodes.map(toNode) } },
  };
}

/** The same capture with the host's nodes removed: only the app's own containers remain. */
export function withoutHostNodes(fixture: CarAppHostFixture): CarAppHostFixture {
  return { ...fixture, nodes: fixture.nodes.filter((node) => !node.id.startsWith("host:")) };
}
