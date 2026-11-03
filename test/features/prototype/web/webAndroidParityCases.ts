import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderPrototypeStill } from "../../../../src/features/prototype/web/webStill";
import { toHtml } from "../../../../src/features/prototype/web/webNodes";

/**
 * The web still against the Android renderer's Roborazzi goldens (#16534), shared by the browser
 * check and the unit test that keeps this table and the budgets in step with the golden directory.
 */

const REPO = join(import.meta.dir, "../../../..");
const VALID_FIXTURES = join(REPO, "test/fixtures/prototype-spec/valid");

/** Recorded by `PrototypeSpecContentScreenshotTest` and its siblings on the Linux reference OS. */
export const ANDROID_GOLDEN_DIR = join(
  REPO,
  "android/control-proxy/src/test/resources/screenshots/prototype",
);

/** Golden name to the most differing pixels the web still may have against it. Only shrinks. */
export const ANDROID_PARITY_BUDGETS = join(
  REPO,
  "test/fixtures/prototype-web/android-parity-budgets.json",
);

/**
 * The Android goldens' screen: `w360dp-h640dp-mdpi`, so one dp is one pixel. `small-phone` is the
 * registry frame of that size; drawn chromeless, only its screen size is used.
 */
export const ANDROID_PARITY_FRAME = "small-phone";
export const ANDROID_PARITY_VIEWPORT = { width: 360, height: 640 } as const;

/**
 * Hosted runners do not all rasterize alike: one spec has moved by up to ~180 pixels between CI
 * runs of the same commit, while one machine repeats its counts exactly. A case fails only beyond
 * this allowance over its budget, so the budget tracks the renderer gap, not the runner. It stays
 * below the golden's pixel count, so a screenshot that differs everywhere always fails.
 */
export function parityAllowance(budget: number, goldenPixels: number): number {
  return Math.min(budget + Math.max(256, Math.ceil(budget * 0.01)), goldenPixels - 1);
}

type Json = Record<string, unknown>;

export interface AndroidParityCase {
  /** The golden's file name without `.png`. */
  readonly golden: string;
  /** A fixture under test/fixtures/prototype-spec/valid, without `.json`. */
  readonly fixture: string;
  /** The device's `night`/`notnight` qualifier; Robolectric's default is light. */
  readonly mode?: "light" | "dark";
  /** Initial state keys replaced, as `stateOverrides` does; each must already be declared. */
  readonly state?: Json;
  /** Takes the `theme` of another fixture, as `themeFrom` does. */
  readonly themeFrom?: string;
  /** The Kotlin case's `edit`, applied last. */
  readonly edit?: (spec: Json) => Json;
}

export interface AndroidParitySkip {
  readonly golden: string;
  readonly reason: string;
}

const asRecord = (value: unknown, what: string): Json => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${what} is not an object`);
  }
  return value as Json;
};

/** `withModeRootBackground`: the root's single dark background becomes a `{light, dark}` pair. */
function withModeRootBackground(spec: Json): Json {
  const root = asRecord(spec.root, "root");
  const style = asRecord(root.style, "root.style");
  if (typeof style.background !== "string") {
    throw new Error("fixture root authors no single background");
  }
  const background = { light: "#FFFFFFFF", dark: style.background };
  return { ...spec, root: { ...root, style: { ...style, background } } };
}

function rootChildren(spec: Json): unknown[] {
  const children = asRecord(spec.root, "root").children;
  if (!Array.isArray(children)) {
    throw new Error("root has no children");
  }
  return children;
}

const withRootChildren = (spec: Json, children: unknown[]): Json => ({
  ...spec,
  root: { ...asRecord(spec.root, "root"), children },
});

/** `withoutRootChild` then `halfDetents`: one of several sheets sharing a key, opened at half. */
function oneHalfSheet(dropped: number): (spec: Json) => Json {
  return (spec) =>
    withRootChildren(
      spec,
      rootChildren(spec)
        .filter((_, index) => index !== dropped)
        .map((child) => {
          const node = asRecord(child, "root child");
          return node.type === "bottomSheet" ? { ...node, detents: ["half"] } : node;
        }),
    );
}

/** `theme-modes-colors` root child indices of its half and full bottom sheets. */
const HALF_SHEET = 1;
const FULL_SHEET = 2;

const HOST_CHROME =
  "host window chrome (dismiss bar, Close control, escape pill) around the content; the web still draws no host chrome";

/** Every golden in ANDROID_GOLDEN_DIR is in exactly one of these two lists. */
export const ANDROID_PARITY_CASES: readonly AndroidParityCase[] = [
  {
    golden: "bottom_sheet_open_dark",
    fixture: "fullscreen-all-nodes",
    mode: "dark",
    state: { open: true },
    edit: withModeRootBackground,
  },
  {
    golden: "bottom_sheet_open_light",
    fixture: "fullscreen-all-nodes",
    state: { open: true },
    edit: withModeRootBackground,
  },
  { golden: "color_role_and_corner_tokens", fixture: "color-role-and-corner-tokens" },
  {
    golden: "dialog_open_dark",
    fixture: "material-app-bar-dialog-pickers",
    mode: "dark",
    state: { editing: true },
  },
  { golden: "doc_example_1", fixture: "doc-example-1" },
  { golden: "doc_example_2", fixture: "doc-example-2" },
  { golden: "elevation_gradient_aspect_ratio", fixture: "elevation-gradient-aspect-ratio" },
  { golden: "flow_basic", fixture: "flow-basic" },
  { golden: "flow_max_lines_repeat", fixture: "flow-max-lines-repeat" },
  { golden: "fullscreen_all_nodes", fixture: "fullscreen-all-nodes" },
  {
    golden: "fullscreen_all_nodes_dark",
    fixture: "fullscreen-all-nodes",
    mode: "dark",
    edit: withModeRootBackground,
  },
  { golden: "grid_adaptive_min_width", fixture: "grid-adaptive-min-width" },
  { golden: "grid_fixed_columns_span", fixture: "grid-fixed-columns-span" },
  { golden: "material_app_bar_dialog_pickers", fixture: "material-app-bar-dialog-pickers" },
  {
    golden: "material_app_bar_dialog_pickers_dark",
    fixture: "material-app-bar-dialog-pickers",
    mode: "dark",
  },
  { golden: "material_controls", fixture: "material-controls" },
  { golden: "material_slider_chip_card", fixture: "material-slider-chip-card" },
  { golden: "repeat", fixture: "repeat" },
  { golden: "repeat_component_labels", fixture: "repeat-component-labels" },
  { golden: "repeat_state_keys", fixture: "repeat-state-keys" },
  { golden: "row_weight_size_bounds", fixture: "row-weight-size-bounds" },
  { golden: "selection_controls", fixture: "selection-controls" },
  { golden: "sheet_bindings", fixture: "sheet-bindings" },
  { golden: "style_polish", fixture: "style-polish" },
  { golden: "style_when", fixture: "style-when" },
  { golden: "style_when_inferred_dark", fixture: "style-when" },
  { golden: "text_style_role", fixture: "text-style-role" },
  {
    golden: "theme_device_controls_dark",
    fixture: "material-controls",
    themeFrom: "theme-device",
    mode: "dark",
  },
  {
    golden: "theme_device_controls_light",
    fixture: "material-controls",
    themeFrom: "theme-device",
  },
  { golden: "theme_device_dark", fixture: "theme-device", mode: "dark" },
  { golden: "theme_device_light", fixture: "theme-device" },
  { golden: "theme_modes_colors_dark", fixture: "theme-modes-colors", mode: "dark" },
  { golden: "theme_modes_colors_light", fixture: "theme-modes-colors" },
  {
    golden: "theme_modes_colors_open_dark",
    fixture: "theme-modes-colors",
    mode: "dark",
    state: { open: true },
    edit: oneHalfSheet(FULL_SHEET),
  },
  {
    golden: "theme_modes_colors_open_light",
    fixture: "theme-modes-colors",
    state: { open: true },
    edit: oneHalfSheet(FULL_SHEET),
  },
  {
    golden: "theme_modes_colors_role_scrim_open_dark",
    fixture: "theme-modes-colors",
    mode: "dark",
    state: { open: true },
    edit: oneHalfSheet(HALF_SHEET),
  },
  {
    golden: "theme_modes_colors_role_scrim_open_light",
    fixture: "theme-modes-colors",
    state: { open: true },
    edit: oneHalfSheet(HALF_SHEET),
  },
  { golden: "theme_role_overrides", fixture: "theme-role-overrides" },
  { golden: "theme_seed", fixture: "theme-seed" },
  {
    golden: "theme_seed_color_roles",
    fixture: "color-role-and-corner-tokens",
    themeFrom: "theme-seed",
  },
  { golden: "theme_seed_controls", fixture: "material-controls", themeFrom: "theme-seed" },
  {
    golden: "theme_seed_slider_chip_card",
    fixture: "material-slider-chip-card",
    themeFrom: "theme-seed",
  },
  { golden: "theme_typography_shapes", fixture: "theme-typography-shapes" },
  {
    golden: "theme_typography_shapes_controls",
    fixture: "material-controls",
    themeFrom: "theme-typography-shapes",
  },
  {
    golden: "theme_typography_shapes_slider_chip_card",
    fixture: "material-slider-chip-card",
    themeFrom: "theme-typography-shapes",
  },
];

export const ANDROID_PARITY_SKIPS: readonly AndroidParitySkip[] = [
  {
    golden: "doc_example_3",
    reason:
      "a floating window captured at its content size with element anchors resolved by the Kotlin test; the web still places the window at its gravity on the screen",
  },
  ...[
    "host_chrome_close_control_dark",
    "host_chrome_close_control_light",
    "host_chrome_dismiss_bar_dark",
    "host_chrome_dismiss_bar_light",
    "host_chrome_escape_pill_dark",
    "host_chrome_escape_pill_light",
    "host_chrome_none_dark",
    "host_chrome_none_light",
  ].map((golden) => ({ golden, reason: HOST_CHROME })),
];

function readFixture(name: string): Json {
  return asRecord(
    JSON.parse(readFileSync(join(VALID_FIXTURES, `${name}.json`), "utf8")),
    `${name}.json`,
  );
}

export function androidParityFixturePath(name: string): string {
  return join(VALID_FIXTURES, `${name}.json`);
}

function withState(spec: Json, overrides: Json): Json {
  const state = asRecord(spec.state ?? {}, "state");
  const unknown = Object.keys(overrides).filter((key) => !(key in state));
  if (unknown.length > 0) {
    throw new Error(`state overrides keys the fixture does not declare: ${unknown.join(", ")}`);
  }
  return { ...spec, state: { ...state, ...overrides } };
}

/** The spec the Kotlin case renders: state, then theme, then its edit, as `validPrototypeFixture`. */
export function androidParitySpec(entry: AndroidParityCase): Json {
  let spec = readFixture(entry.fixture);
  if (entry.state) {
    spec = withState(spec, entry.state);
  }
  if (entry.themeFrom) {
    spec = { ...spec, theme: asRecord(readFixture(entry.themeFrom).theme, "theme") };
  }
  return entry.edit ? entry.edit(spec) : spec;
}

/**
 * The Android goldens render `PrototypeSpecContent(model.root, model.theme)`, which applies no
 * window placement, so a sheet or floating spec draws from the top-left there. The comparison
 * places every spec fullscreen to draw the same content path.
 */
export function contentOnly(spec: Json): Json {
  const window = spec.window === undefined ? {} : asRecord(spec.window, "window");
  return { ...spec, window: { ...window, placement: { type: "fullscreen" } } };
}

/**
 * A bare document holding only the chromeless still at the top-left: no page shell, toolbar or
 * fit-to-window scale, so one CSS pixel is one golden pixel.
 */
export function androidParityHtml(entry: AndroidParityCase): string {
  const still = renderPrototypeStill(contentOnly(androidParitySpec(entry)), {
    frame: ANDROID_PARITY_FRAME,
    mode: entry.mode ?? "light",
    chromeless: true,
  });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>*{box-sizing:border-box}html,body{margin:0}</style></head><body>${toHtml(still.element)}</body></html>\n`;
}

export function readAndroidParityBudgets(): Record<string, number> {
  return asRecord(
    JSON.parse(readFileSync(ANDROID_PARITY_BUDGETS, "utf8")),
    "android-parity-budgets.json",
  ) as Record<string, number>;
}
