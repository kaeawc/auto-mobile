import type { PROTOTYPE_NODE_TYPES } from "./prototypeNodeTypes";

/**
 * Node → hand-owned code mapping for `automobile:prototype/eject` (#14129). The eject is a
 * deterministic one-shot scaffold for a fixed subset of nodes (layout, text, buttons, fields,
 * lists, `stack`); every other node type is `"stub"` and becomes a labelled stub that keeps its
 * `testTag` and its children. Keyed by every node type, so adding one to the contract fails the
 * type check until it is classified here.
 */
export type PrototypeNodeType = (typeof PROTOTYPE_NODE_TYPES)[number];

export interface EjectTarget {
  /** The Jetpack Compose component the scaffold writes. */
  readonly compose: string;
  /** The SwiftUI view the scaffold writes. */
  readonly swiftUi: string;
}

export const PROTOTYPE_EJECT_MAPPING = {
  box: { compose: "Box", swiftUi: "ZStack" },
  row: { compose: "Row", swiftUi: "HStack" },
  column: { compose: "Column", swiftUi: "VStack" },
  flow: "stub",
  grid: "stub",
  carousel: "stub",
  text: { compose: "Text", swiftUi: "Text" },
  image: "stub",
  icon: "stub",
  spacer: { compose: "Spacer", swiftUi: "Spacer" },
  textField: { compose: "TextField / OutlinedTextField", swiftUi: "TextField / SecureField" },
  searchBar: "stub",
  switch: "stub",
  checkbox: "stub",
  button: { compose: "Button (by variant)", swiftUi: "Button" },
  pasteButton: "stub",
  radioGroup: "stub",
  select: "stub",
  listItem: { compose: "ListItem", swiftUi: "HStack" },
  slider: "stub",
  chip: "stub",
  card: { compose: "Card", swiftUi: "VStack" },
  iconButton: "stub",
  fab: "stub",
  segmentedButton: "stub",
  topAppBar: "stub",
  divider: { compose: "HorizontalDivider / VerticalDivider", swiftUi: "Divider" },
  badge: "stub",
  progress: "stub",
  chart: "stub",
  dialog: "stub",
  menu: "stub",
  snackbar: "stub",
  timePicker: "stub",
  datePicker: "stub",
  list: { compose: "LazyColumn / LazyRow", swiftUi: "ScrollView + LazyVStack / LazyHStack" },
  scroll: { compose: "Column / Row + scroll modifier", swiftUi: "ScrollView" },
  pager: "stub",
  stack: { compose: "when over a back stack", swiftUi: "switch over a back stack" },
  tabBar: "stub",
  bottomNav: "stub",
  bottomSheet: "stub",
  tooltip: "stub",
  adaptive: "stub",
  drawer: "stub",
  videoPlayer: "stub",
  map: "stub",
  castButton: "stub",
  cameraPreview: "stub",
  webView: "stub",
} as const satisfies Record<PrototypeNodeType, EjectTarget | "stub">;

/** The node types the scaffold writes real code for. */
export type EjectScaffoldType = {
  [K in PrototypeNodeType]: (typeof PROTOTYPE_EJECT_MAPPING)[K] extends "stub" ? never : K;
}[PrototypeNodeType];

export function isEjectScaffoldType(type: unknown): type is EjectScaffoldType {
  return (
    typeof type === "string" &&
    Object.hasOwn(PROTOTYPE_EJECT_MAPPING, type) &&
    PROTOTYPE_EJECT_MAPPING[type as PrototypeNodeType] !== "stub"
  );
}
