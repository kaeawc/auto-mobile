import type { ModelSelection, TypeRefs } from "./generate-prototype-spec-models";

/**
 * Contract objects and tagged unions emitted as models. Kotlin is `Prototype<Name>` and Swift
 * is `<Name>` unless renamed. `languages` limits emission to consumers; conformances and docs
 * preserve each native API. Type refs below bridge definitions that remain hand-written.
 */
export const prototypeModelSelection = {
  offset: {},
  padding: {},
  bounds: { languages: ["kotlin"] },
  sheetCondition: { languages: ["kotlin"] },
  safeAreaPadding: {},
  animate: {
    languages: ["kotlin"],
    doc: "A node's style animation (#14208): `durationMs` 0..2000 (default 300) and `easing`.",
  },
  stagger: {
    languages: ["kotlin"],
    doc: "Container `stagger` (#15247): each `visibleWhen` child enters `ms` after the previous one.",
  },
  zoomable: {
    languages: ["kotlin"],
    doc: "An image's zoom range: 1 up to `maxScale` (1..8).",
  },
  radioOption: { languages: ["kotlin"] },
  chartRange: {
    swiftName: "PrototypeChartRange",
    doc: "A fixed y axis for a chart; `max` is above `min`.",
  },
  container: { languages: ["kotlin"] },
  selector: { languages: ["kotlin"] },
  shader: { kotlinName: "PrototypeShader", swiftName: "PrototypeShader" },
  styleWhenEntry: { languages: ["kotlin"], kotlinName: "PrototypeStyleWhen" },
  appBarAction: {
    swiftName: "PrototypeAppBarAction",
    swiftConformances: ["Decodable"],
    doc: "An icon-only control in a `topAppBar`: the icon, its accessible label and its tap.",
  },
  dialogButton: {
    swiftName: "PrototypeDialogButton",
    swiftConformances: ["Decodable"],
    doc: "A `dialog` or `snackbar` button: a tap closes its container, then runs `onTap`.",
  },
  scrollRefresh: {
    languages: ["kotlin"],
    doc: "Pull-to-refresh on a vertical [PrototypeScrollNode]: the indicator shows while the boolean state\n[stateKey] is true. A pull writes true to it and runs [onRefresh]; the prototype or a patch\nwrites false to end it.",
  },
  anchor: {
    languages: ["kotlin"],
    variantDocs: {
      bounds:
        "Screen-space dp [bounds]. [alignment] (`cover` when absent) lays the node over them or along one\nof their edges, then [offset] shifts it. The host resolves an element anchor into this shape, so\nit is the only anchor the renderer lays out (#9316).",
    },
  },
  placement: { swiftConformances: ["Decodable"] },
  gradient: { languages: ["kotlin"] },
  listItemTrailing: {
    swiftName: "PrototypeListItemTrailing",
    variantNames: {
      switch: "PrototypeListItemSwitch",
      checkbox: "PrototypeListItemCheckbox",
      icon: "PrototypeListItemIcon",
    },
    doc: "The control at the end of a `listItem`: a bound switch or checkbox, or a decorative icon.",
  },
  gradientStop: {
    languages: ["swift"],
    swiftName: "PrototypeGradientStop",
    swiftConformances: ["Decodable", "Equatable"],
    doc: "One gradient stop: a colour slot and an optional position in 0...1.",
  },
  border: { languages: ["swift"], swiftConformances: ["Decodable"] },
  // Kotlin border/gradientStop/item retain secondary constructors used by many callers.
  // action/node carry JSON/map fields; condition/style have large, ref-heavy choice types.
  // Swift gradient keeps its stop-count and position validation in its hand-written decoder.
} as const satisfies ModelSelection;

export const prototypeTypeRefs = {
  colorValue: { kotlin: "PrototypeModeValue", swift: "PrototypeModeValue" },
  action: { kotlin: "PrototypeAction", swift: "PrototypeAction" },
  condition: { kotlin: "PrototypeCondition" },
  style: { kotlin: "PrototypeStyle" },
  gradientStop: { kotlin: "PrototypeGradientStop" },
} as const satisfies TypeRefs;
