import type { ModelSelection } from "./generate-prototype-spec-models";

/**
 * Contract definitions emitted as plain models. Kotlin is `Prototype<Name>`; Swift is `<Name>`
 * unless `swiftName` says otherwise. `languages` limits a model to the sides that consume it, so
 * no unused type is generated. `doc` becomes the type's doc comment.
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
} as const satisfies ModelSelection;
