import type { ElementContainerSelector } from "../../src/models/PinchOnOptions";
import type { ElementSelectionStrategy } from "../../src/models/ElementSelectionStrategy";

interface ScopeRow {
  name: string;
  container?: ElementContainerSelector;
  selectionStrategy?: ElementSelectionStrategy;
  nested: boolean;
  anyContainer: boolean;
  swipeContainer: boolean;
  swipeLookFor: boolean;
}
const container = { elementId: "android:id/notification_headerless_view_column" };
const outer = { elementId: "com.android.systemui:id/notification_children_container" };
export const scopedSelectionMatrix: readonly ScopeRow[] = [
  { name: "none", nested: false, anyContainer: false, swipeContainer: false, swipeLookFor: false },
  {
    name: "one",
    container,
    nested: false,
    anyContainer: true,
    swipeContainer: false,
    swipeLookFor: true,
  },
  {
    name: "nested",
    container: { ...container, container: outer },
    nested: true,
    anyContainer: true,
    swipeContainer: true,
    swipeLookFor: true,
  },
  {
    name: "index",
    container: { ...container, index: 0 },
    nested: false,
    anyContainer: true,
    swipeContainer: true,
    swipeLookFor: true,
  },
  {
    name: "level strategy",
    container: { ...container, selectionStrategy: "random" },
    nested: false,
    anyContainer: true,
    swipeContainer: true,
    swipeLookFor: true,
  },
  {
    name: "unique",
    selectionStrategy: "unique",
    nested: true,
    anyContainer: true,
    swipeContainer: false,
    swipeLookFor: true,
  },
  {
    name: "one + unique",
    container,
    selectionStrategy: "unique",
    nested: true,
    anyContainer: true,
    swipeContainer: false,
    swipeLookFor: true,
  },
  {
    name: "nested + unique",
    container: {
      ...container,
      selectionStrategy: "random",
      container: { ...outer, selectionStrategy: "random" },
    },
    selectionStrategy: "unique",
    nested: true,
    anyContainer: true,
    swipeContainer: true,
    swipeLookFor: true,
  },
  {
    name: "index + unique",
    container: { ...container, index: 0, selectionStrategy: "random" },
    selectionStrategy: "unique",
    nested: true,
    anyContainer: true,
    swipeContainer: true,
    swipeLookFor: true,
  },
  {
    name: "level strategy + unique",
    container: { ...container, selectionStrategy: "random" },
    selectionStrategy: "unique",
    nested: true,
    anyContainer: true,
    swipeContainer: true,
    swipeLookFor: true,
  },
];
