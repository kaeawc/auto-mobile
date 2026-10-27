import type { ModelOptions, TypeRefs } from "./prototype-model-selection";

export const actionModelOptions = {
  languages: ["kotlin"],
  fieldTypes: {
    "platform.args": { kotlin: "Map<String, JsonElement>" },
    "emit.context": {
      kotlin: "Map<String, EmitContextBinding>",
    },
    "setPage.page": {
      kotlin: "PrototypePageTarget",
    },
    "setState.value": {
      kotlin: "PrototypeScalar",
    },
    "setData.value": {
      kotlin: "EmitContextBinding",
    },
    "appendData.value": {
      kotlin: "EmitContextBinding",
    },
    "prependData.value": {
      kotlin: "EmitContextBinding",
    },
    "request.headers": {
      kotlin: "Map<String, JsonElement>",
    },
    "request.query": {
      kotlin: "Map<String, JsonElement>",
    },
    "request.body": {
      kotlin: "EmitContextBinding",
    },
    "request.append": {
      kotlin: "PrototypeRequestAppend",
    },
    "scrollTo.to": {
      kotlin: "JsonElement",
    },
  },
  fieldDefaults: {},
  fieldDocs: {},
  variantDocs: {
    setData:
      "`setData`, `appendData` and `removeData` change the prototype's own `/data` on the device\n(`prototype_data_actions_v1`, #12519). [path] is `/data/<RFC 6901 pointer>`; inside a `repeat`, a\nwhole `{index}` segment binds to the current row. [value] is an emit-context binding without\n`page`: `{value}`, `{state}`, `{data}` and, in a repeat, `{item}` or `{index}`.",
    request:
      "An HTTP call from a tap (`prototype_network_v1`, #12523): the response goes to [into] (and its\n`<into>__meta` sibling), [statusKey] follows `loading`, `success` and `error`, and [onSuccess] or\n[onError] runs afterwards. [headers] and [query] entries are a literal string or a value binding\n(`{state}`, `{data}`, `{value}`, and `{item}` / `{index}` in a repeat), kept as JSON because both\nforms share a slot; [body] is a binding. [method] defaults to GET and [via] to `host`.",
    platform:
      "A platform call (`prototype_platform_v1`, #14294): [call] is `<module>.<op>` from the contract's\n`platformModules` table, each [args] entry a value binding (`{value}`, `{state}`, `{data}`,\n`{platform}`, `{item}` / `{index}` in a repeat and `{event}` inside a handler) kept as JSON. The\nresult goes to [into] (and `<into>__meta`), [statusKey] follows `loading`, `success` and `error`,\nand [onSuccess] or [onError] runs afterwards. Dispatch is the module registry's (#14295).",
    scrollTo:
      'Moves the scroll whose id is [scroll] (`prototype_chat_scroll_v1`, #14232): [to] is `"start"`,\n`"end"` or `{key: value}`, a `repeat.key` value of a row inside it, kept as JSON.',
  },
} as const satisfies ModelOptions;

export const nodeModelOptions = {
  languages: ["kotlin"],
  // The paste button computes its clipboard tap rather than accepting authored actions.
  kotlinHandWrittenVariants: ["pasteButton"],
  fieldTypes: {
    validateOn: { kotlin: "PrototypeValidateOn" },
    transition: { kotlin: "PrototypeTransition" },
    "pager.peek": { kotlin: "PrototypePagerPeek" },
    "grid.columns": {
      kotlin: "PrototypeGridColumns",
    },
    "stack.screens": {
      kotlin: "Map<String, PrototypeNode>",
    },
  },
  fieldDefaults: {
    "image.contentScale": {
      kotlin: '"fit"',
    },
    "button.variant": {
      kotlin: '"filled"',
    },
    "card.variant": {
      kotlin: '"filled"',
    },
    "iconButton.variant": {
      kotlin: '"standard"',
    },
    "fab.size": {
      kotlin: '"regular"',
    },
    "topAppBar.variant": {
      kotlin: '"small"',
    },
    "divider.orientation": {
      kotlin: '"horizontal"',
    },
    "progress.variant": {
      kotlin: '"linear"',
    },
    "list.axis": {
      kotlin: '"vertical"',
    },
    "list.endThreshold": {
      kotlin: "3",
    },
    "drawer.dismissOnSwipe": {
      kotlin: "true",
    },
    "tooltip.caret": {
      kotlin: '"auto"',
    },
    "scroll.axis": {
      kotlin: '"vertical"',
    },
    "tabBar.scrollable": {
      kotlin: "false",
    },
    "bottomSheet.dragHandle": {
      kotlin: "true",
    },
    "bottomSheet.dismissOnSwipe": {
      kotlin: "true",
    },
    "chart.xLabels": {
      kotlin: '"none"',
    },
  },
  fieldDocs: {
    "box.stagger": "Spaces the enters of `visibleWhen` children apart (#15247).",
    "row.stagger": "Spaces the enters of `visibleWhen` children apart (#15247).",
    "column.stagger": "Spaces the enters of `visibleWhen` children apart (#15247).",
    "text.linkify":
      "Mentions, hashtags and URLs in [text] as links (`prototype_linkify_v1`, #14233).",
    "image.asset": "An uploaded image asset id, or a `{light, dark}` pair of ids (#11218).",
    "image.zoomable": "Pinch, double-tap and pan zoom up to `maxScale` (#14208).",
    "icon.variant":
      "One of filled (default), outlined, rounded, sharp, twoTone; closed by the contract.",
    "scroll.reverse":
      "Chat lists (`prototype_chat_scroll_v1`, #14232): anchored at the end of its content.",
    "scroll.stickToEnd": "Follows rows appended while the scroll is at its end.",
    "scroll.atEndKey": "A boolean state key the runtime keeps true while the scroll is at its end.",
    "scroll.onStartReached":
      "Run once each time the scroll reaches its start, to load older history.",
  },
  variantDocs: {
    carousel:
      "A horizontally scrolling, snapping row of [children] (one item each, expanded from [repeat]).\n[variant] is `multiBrowse` (default), `hero` or `uncontained`; [itemWidth] is the preferred or\nfixed item width in dp.",
    iconButton:
      "An icon-only Material button; `variant` is standard (default), filled, tonal or outlined.",
    fab: "A floating action button; a `label` makes it an extended FAB, which has no `size`.",
    segmentedButton:
      "A single-select Material segmented button bound to a string state key, like a `radioGroup`.",
    topAppBar:
      "A Material top app bar with a title, an optional navigation icon and up to three actions.",
    divider: "A Material divider line, horizontal (default) or vertical.",
    badge: "A Material badge: a small dot, or a short `text` such as a count.",
    progress:
      "A Material progress indicator, linear (default) or circular: determinate over 0..[max] when bound\nto a number, indeterminate otherwise.",
    dialog:
      "A Material alert dialog, open while [openWhen] holds. Its buttons and scrim close it by writing\nthe opposite boolean; [child] is optional custom content between the text and the buttons.",
    snackbar:
      "A Material snackbar at the bottom of the window, shown while [openWhen] holds. Without\n[durationMs] it stays until its action closes it or the state changes; with it, it closes itself\nby writing the opposite boolean once it has been open that long (a wall-clock timer).",
    timePicker:
      "A Material time picker bound to integer hour (0..23) and minute (0..59) state keys.",
    datePicker: "A Material date picker bound to a `YYYY-MM-DD` string state key.",
    chart:
      "A `chart` (#14209): a [variant] line, area, bar or ring over 1–4 [series], each the objects of a\n`/data` array read through its `y` (and optional `x`) member. A ring draws its one series' latest\nvalue against [goal]; other variants draw [goal] as a reference line.",
  },
  omitKotlinFields: ["ios", "android"],
  kotlinBase: {
    fields: [
      "id",
      "testTag",
      "contentDescription",
      "onTap",
      "onLongPress",
      "onDoubleTap",
      "style",
      "styleWhen",
      "visibleWhen",
      "sharedKey",
      "transition",
      "animate",
      "anchor",
      "span",
      "safeAreaPadding",
      "scrollTransition",
      "scrollLinked",
      "onAppear",
      "semantics",
    ],
    docs: {
      contentDescription:
        "The node's accessible label; replaces the label derived from its text, icon or kind.",
      transition:
        "`none`, `fade`, `expand`, `slide`, or (#14208) `slideStart`, `slideEnd` or `scale`, or (#15247)\n`blurReplace`: the `visibleWhen` enter/exit; absent is fade + expand. Start and end follow the\nlayout direction. Written as the type alone or `{type, delayMs?}`.",
      animate:
        "Animates styleWhen-driven alpha, offset, scale, rotation, background and color (#14208).",
    },
  },
} as const satisfies ModelOptions;

export const nodeActionTypeRefs = {
  platformBinding: { kotlin: "JsonElement" },
  repeat: {
    kotlin: "PrototypeRepeat",
  },
  swipeActions: {
    kotlin: "PrototypeSwipeActions",
  },
  pagerDp: {
    kotlin: "Double",
  },
  textSpan: {
    kotlin: "PrototypeTextSpan",
  },
  linkify: {
    kotlin: "PrototypeLinkifyOptions",
  },
  iconName: {
    kotlin: "String",
  },
  iconVariant: {
    kotlin: "String",
  },
  check: {
    kotlin: "PrototypeCheck",
  },
  menuItem: {
    kotlin: "PrototypeMenuItem",
  },
  pagerPageSize: {
    kotlin: "PrototypePagerPageSize",
  },
  detent: {
    kotlin: "PrototypeDetent",
  },
  chartSeries: {
    kotlin: "PrototypeChartSeries",
  },
} as const satisfies TypeRefs;
