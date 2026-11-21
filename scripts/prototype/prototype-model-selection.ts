import {
  actionModelOptions,
  nodeActionTypeRefs,
  nodeModelOptions,
} from "./prototype-model-node-action-options";

export type ModelLanguage = "kotlin" | "swift";
export type TypeRefs = Readonly<
  Record<string, { readonly kotlin?: string; readonly swift?: string }>
>;
export interface ModelOptions {
  readonly languages?: readonly ModelLanguage[];
  readonly swiftName?: string;
  readonly kotlinName?: string;
  readonly swiftConformances?: readonly string[];
  readonly variantNames?: Readonly<Record<string, string>>;
  readonly variantDocs?: Readonly<Record<string, string>>;
  readonly doc?: string;
  /** Field keys are `field` or `variant.field`; variant entries take precedence per language. */
  readonly fieldTypes?: TypeRefs;
  readonly fieldDocs?: Readonly<Record<string, string>>;
  /** Fields the typed Kotlin models deliberately omit (validated by the contract, stripped before decode). */
  readonly omitKotlinFields?: readonly string[];
  /** Existing Kotlin constructor parameters in order, followed by new fields in contract order. */
  readonly kotlinFieldOrder?: readonly string[];
  /** Kotlin non-null defaults for optional fields; Swift defaults are unsupported. */
  readonly fieldDefaults?: TypeRefs;
  readonly kotlinBase?: {
    readonly fields: readonly string[];
    readonly docs?: Readonly<Record<string, string>>;
  };
  readonly kotlinStringOverloads?: readonly string[];
  /** Variants implemented by hand, whose fields still participate in the Kotlin base. */
  readonly kotlinHandWrittenVariants?: readonly string[];
  readonly validators?: TypeRefs;
}
export type ModelSelection = Readonly<Record<string, ModelOptions>>;

/**
 * Contract objects and tagged unions emitted as models. Kotlin is `Prototype<Name>` and Swift
 * is `<Name>` unless renamed. `languages` limits emission to consumers; conformances and docs
 * preserve each native API. Type refs below bridge definitions that remain hand-written.
 */
export const prototypeModelSelection = {
  dataWhere: {
    swiftName: "PrototypeDataWhere",
    swiftConformances: ["Decodable", "Equatable", "Sendable"],
    fieldTypes: { equals: { kotlin: "EmitContextBinding", swift: "JSONValue" } },
  },
  requestUploadFile: {},
  requestUploadPart: {},
  channel: {
    languages: ["kotlin"],
    fieldTypes: { headers: { kotlin: "Map<String, JsonElement>" } },
  },
  channelReconnect: { languages: ["kotlin"] },
  channelRoute: { languages: ["kotlin"], fieldTypes: { when: { kotlin: "JsonElement" } } },
  iconEffectTrigger: {},
  iconEffect: {},
  loop: { languages: ["kotlin"] },
  press: { swiftName: "PrototypePress", swiftConformances: ["Decodable", "Equatable", "Sendable"] },
  shared: { swiftConformances: ["Decodable", "Equatable", "Sendable"] },
  shadow: { swiftConformances: ["Decodable", "Equatable", "Sendable"] },
  fadeEdges: {},
  glass: {
    swiftName: "PrototypeGlassOptions",
    swiftConformances: ["Decodable", "Equatable", "Sendable"],
  },
  glassGroup: {},
  backdrop: { languages: ["kotlin"] },
  semantics: { languages: ["kotlin"] },
  imageFilter: { swiftConformances: ["Decodable", "Equatable", "Sendable"] },
  // tooltipCaret/drawerEdge and text.contentTransition are enum rules: native node fields use strings.
  tooltipSpotlight: {
    doc: "Tooltip spotlight hole: padding 0..64 dp (default 8), cornerRadius 0..64 dp (default 12).",
  },
  // Swift Action is a flat struct and Node a final class with different shapes; both stay hand-written.
  action: actionModelOptions,
  node: {
    ...nodeModelOptions,
    kotlinBase: {
      ...nodeModelOptions.kotlinBase,
      fields: [...nodeModelOptions.kotlinBase.fields, "keyframes", "attentionLoop"],
    },
  },
  routeEntry: { languages: ["kotlin"] },
  route: { languages: ["kotlin"] },
  swipeAction: {
    languages: ["kotlin"],
    doc: "One swipe-revealed button: [label] is its text and accessibility name, [role] `destructive`\nselects error colours, [color] (hex or theme role) overrides the background.",
  },
  swipeActions: {
    languages: ["kotlin"],
    doc: "A right swipe reveals `start`, a left swipe `end`; [fullSwipe] runs the first entry.",
  },
  textSpan: { languages: ["kotlin"] },
  textSpanStyle: {
    languages: ["kotlin"],
    fieldTypes: { fontFamily: { kotlin: "PrototypeFontFamily" } },
    // Preserve the existing native fields; span stagger has no Kotlin model field.
    omitKotlinFields: ["stagger"],
  },
  linkify: {
    languages: ["kotlin"],
    kotlinName: "PrototypeLinkifyOptions",
    fieldTypes: { onTap: { kotlin: "JsonArray" } },
    doc: "`linkify` on a text node: the [kinds] to detect, the [style] of a match and the actions a tap\nruns. [onTap] stays JSON because its `{match}` bindings are bound per match before decoding\n([PrototypeLinkify.actions]).",
  },
  chartSeries: {
    languages: ["kotlin"],
    doc: "One chart series: the `/data` array at [path], its points' [y] and optional [x] members.",
  },
  // themeColors stays hand-written: its constructor places light/dark after the colour roles.
  themeTypography: {
    languages: ["kotlin"],
    kotlinName: "PrototypeSpecThemeTypography",
    doc: "`scale` multiplies every Material type role; `fontFamily` is sans, serif or mono.",
  },
  themeShapes: {
    languages: ["kotlin"],
    kotlinName: "PrototypeSpecThemeShapes",
    doc: "`corner` picks one of the Material corner families (none, small, medium, large, full).",
  },
  theme: {
    languages: ["kotlin"],
    kotlinName: "PrototypeSpecTheme",
    fieldTypes: { colors: { kotlin: "PrototypeSpecThemeColors" } },
    omitKotlinFields: ["ios", "android"],
  },
  platformHandlers: {
    languages: ["kotlin"],
    doc: "Root `platform`: action lists keyed by `<module>.<event>`.",
  },
  platformRequires: {
    languages: ["kotlin"],
    kotlinName: "PrototypeRequires",
    // An empty list means "none declared"; PrototypeRequiresSerializer omits it on encode.
    fieldDefaults: { capabilities: { kotlin: "emptyList()" } },
    doc: "The root `requires` block (#14294): platform modules, permissions, background needs and\nexplicit capabilities.",
  },
  platformPermission: {
    languages: ["kotlin"],
    kotlinName: "PrototypePermissionRequirement",
    doc: "One declared permission: a canonical [name] and the [purpose] shown to the user.",
  },
  scrollEdge: {},
  scrollTransition: {},
  scrollLinked: {},
  iosPresentationNamespace: {
    fieldTypes: { backgroundExtension: { kotlin: "Boolean", swift: "Bool" } },
  },
  iosNamespace: {
    swiftConformances: ["Decodable"],
    fieldTypes: {
      bottomAccessory: { swift: "PrototypeNode" },
      backgroundExtension: { kotlin: "Boolean", swift: "Bool" },
    },
  },
  androidNamespace: {},
  offset: {},
  padding: {},
  bounds: { languages: ["kotlin"] },
  sheetCondition: { languages: ["kotlin"] },
  safeAreaPadding: {},
  animate: {
    doc: "A node's style animation: mutually exclusive `tempo` or `durationMs`/`easing`.",
  },
  stagger: {
    languages: ["kotlin"],
    doc: "Container `stagger` (#15247): each `visibleWhen` child enters `ms` after the previous one.",
  },
  zoomable: {
    swiftName: "PrototypeImageZoomable",
    swiftConformances: ["Decodable"],
    doc: "An image's zoom range: 1 up to `maxScale` (1..8).",
  },
  radioOption: {},
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
  window: {
    languages: ["kotlin"],
    omitKotlinFields: ["ios", "android"],
    kotlinFieldOrder: [
      "placement",
      "opacity",
      "layer",
      "persistence",
      "chrome",
      "deadTaps",
      "backdrop",
      "transition",
      "keepScreenOn",
      "layoutDirection",
      "brightness",
      "orientation",
      "statusBar",
    ],
    fieldTypes: { brightness: { kotlin: "JsonElement" } },
    fieldDefaults: { opacity: { kotlin: "100" } },
    fieldDocs: {
      layer:
        "`system` (default when absent) stacks above system UI as an accessibility overlay; `app` stacks\njust above apps, below the shade, keyboard and screenshot preview, and needs\nSYSTEM_ALERT_WINDOW.",
      persistence:
        "`session` (default when absent) ends the prototype with its host session; `device` keeps it\ninteractive after the last client disconnects and disables the idle timeout.",
      chrome:
        "Fullscreen host chrome: `none` by default, or `bar`; device persistence defaults to `bar`.",
      deadTaps: "Opt-in window-local dead-tap events; coordinates never include field contents.",
      backdrop: "Blur or tonal fill behind the window (`prototype_backdrop_v1`, #15126).",
      keepScreenOn:
        "Overlay-scoped window controls (`prototype_platform_window_controls_v1`, #14320).",
      layoutDirection:
        "Protocol parity only; Android does not advertise or apply layout direction.",
      brightness: '`"system"` or a whole 0-100 brightness.',
    },
  },
  gradient: {
    swiftName: "PrototypeGradient",
    swiftConformances: ["Decodable", "Equatable"],
    validators: { stops: { swift: "PrototypeGradient.validateStops" } },
  },
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
    kotlinStringOverloads: ["color"],
    swiftName: "PrototypeGradientStop",
    swiftConformances: ["Decodable", "Equatable"],
    doc: "One gradient stop: a colour slot and an optional position in 0...1.",
  },
  border: { swiftConformances: ["Decodable"], kotlinStringOverloads: ["color"] },
  item: {
    swiftName: "NavItem",
    swiftConformances: ["Decodable"],
    kotlinStringOverloads: ["image"],
    fieldDocs: { image: "An uploaded image asset id, or a `{light, dark}` pair of ids (#11218)." },
  },
  // Swift Condition and Style use structurally different representations and stay hand-written.
  condition: {
    languages: ["kotlin"],
    fieldTypes: {
      valid: { kotlin: "PrototypeValidityKeys" },
      contains: { kotlin: "PrototypeScalar" },
      startsWith: { kotlin: "PrototypeScalar" },
    },
    fieldDocs: {
      platform: "A `/platform` pointer (#14294); platform state is device-owned and read-only.",
      empty: 'With [data]: holds when that value is missing, `[]`, `{}` or `""` (#14207).',
    },
  },
  style: {
    languages: ["kotlin"],
    fieldTypes: { fontFamily: { kotlin: "PrototypeFontFamily" } },
    fieldDocs: {
      background:
        "Hex, colour role, or a `{light, dark}` pair of either, as every colour slot (#11218).",
      cornerRadius: "A dp number, a Material Shapes token, or per-corner dp radii.",
      shadowColor:
        "Hex or colour role tinting the `elevation` shadow; absent keeps the platform shadow colour.",
      offset:
        "A dp draw offset; it moves the drawn and touchable node without changing its layout slot.",
      pressScale:
        "Scale (0.5-1) a tappable node shrinks to while pressed; absent leaves it unscaled.",
      shimmer: "An animated highlight sweep over a loading placeholder's background (#14207).",
      scale: "A drawn scale (0-4) about the node's centre; absent is 1 (#14208).",
      rotation: "A drawn rotation in degrees (-360..360) about the node's centre (#14208).",
      lineHeight: "Positive sp between baselines.",
      letterSpacing: "sp added between letters; negative tightens.",
      textDecoration: "`none`, `underline`, `lineThrough` or `underlineLineThrough`.",
      fontStyle: "`normal` or `italic`.",
      overflow:
        "How text past `maxLines` or its width ends: `clip` (default), `ellipsis` or `visible`.",
      textStyle:
        "A Material 3 type role (`titleLarge`, ...); explicit size, weight and family still win.",
    },
  },
} as const satisfies ModelSelection;

export const prototypeTypeRefs = {
  requestUploadValue: { kotlin: "kotlinx.serialization.json.JsonObject", swift: "JSONValue" },
  routeParams: { kotlin: "Map<String, JsonElement>" },
  ...nodeActionTypeRefs,
  iconEffectRepeat: { kotlin: "PrototypeIconEffectRepeat", swift: "PrototypeIconEffectRepeat" },
  colorValue: { kotlin: "PrototypeModeValue", swift: "PrototypeModeValue" },
  action: { kotlin: "PrototypeAction", swift: "PrototypeAction" },
  condition: { kotlin: "PrototypeCondition" },
  style: { kotlin: "PrototypeStyle" },
  gradientStop: { kotlin: "PrototypeGradientStop" },
  gradient: { kotlin: "PrototypeGradient", swift: "PrototypeGradient" },
  dimension: { kotlin: "PrototypeDimension" },
  cornerRadius: { kotlin: "PrototypeCornerRadius" },
  imageAsset: { kotlin: "PrototypeModeValue", swift: "PrototypeModeValue" },
  semantics: { swift: "PrototypeSemantics" },
  effect: { kotlin: "JsonObject" },
  keyframes: { kotlin: "JsonObject" },
  colorToken: { kotlin: "String" },
  listRepeat: { kotlin: "PrototypeRepeat" },
} as const satisfies TypeRefs;
