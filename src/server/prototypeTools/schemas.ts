import { validatePrototypeSimulateInput } from "../prototypeSimulateAction";
import { z as specZ, type ZodTypeAny } from "zod";
import { PROTOVIEWER_DEFAULT_TIMEOUT_MS } from "../../features/prototype/protoViewer/protoViewerDevice";
import { zodToJsonSchema } from "zod-to-json-schema";
import { prototypeContractPatterns } from "../../features/prototype/prototypeContractPatterns";
import { z } from "zod/v4";
import { deleteInternalToolParams } from "../../daemon/wire/constants";
import { PROTOTYPE_EVENT_KINDS } from "../../features/observe/android/ctrlProxyProtocol";
import { PROTOTYPE_APPEARANCE_INPUTS } from "../../features/prototype/prototypeAppearance";
import {
  MAX_PROTOTYPE_ASSET_COUNT,
  MAX_PROTOTYPE_ASSET_ID_LENGTH,
} from "../../features/prototype/prototypeAssets";
import {
  expandPrototypeComponents,
  MAX_PROTOTYPE_COMPONENT_DEPTH,
} from "../../features/prototype/prototypeComponents";
import {
  DEFAULT_PROTOTYPE_EVENT_TIMEOUT_MS,
  MAX_PROTOTYPE_EVENT_TIMEOUT_MS,
} from "../../features/prototype/prototypeEventTimeout";
import { MAX_PROTOTYPE_PATCH_OPS } from "../../features/prototype/prototypePatch";
import {} from "../../features/prototype/prototypeAccessibilityLint";
import {} from "../../features/prototype/prototypePlaceholderLint";
import {
  MAX_PROTOTYPE_LIST_ITEMS,
  MAX_PROTOTYPE_SPEC_BYTES,
  prototypeSpecSchema,
  type PrototypeData,
} from "../../features/prototype/prototypeSpec";
import { STATE_KEY } from "../../features/prototype/prototypeTemplate";
import {
  prototypeDataError,
  validatePrototypeSpec,
} from "../../features/prototype/prototypeValidation";
import { getRemovedToolActionHint } from "../../utils/removedTools";
import { addDeviceTargetingToSchema, withJsonSchemaOverride } from "../../utils/schemaHelpers";
import {} from "../prototypeReverse";
import { validatePrototypeSavedInput } from "../prototypeSavedActions";
import { validatePrototypeStorageInput } from "../prototypeStorageAction";
import {} from "../prototypeStorageOutput";
import { prototypeOutputSchema } from "./outputSchemas";
export { prototypeOutputSchema };
/** MCP name of the on-device prototype tool. */
export const PROTOTYPE_TOOL_NAME = "prototype";

// The settled spec is Zod 3; registry/device targeting use Zod 4. It is converted with
// the same `zod-to-json-schema` options the v1 MCP SDK's `toJsonSchemaCompat` applied to a
// Zod 3 schema, so the advertised schema is unchanged by the SDK v2 migration (#4678) and
// no second spec schema is authored.
const convertSpec = (schema: ZodTypeAny): Record<string, unknown> =>
  zodToJsonSchema(schema, { strictUnions: true, pipeStrategy: "input" });
// Give JSON Schema a canonical root before the recursive window/theme bottom-accessory slots.
// Preserve the device parser's field order for serialized native resources.
const { root: advertisedRoot, ...advertisedFields } = prototypeSpecSchema.shape;
const advertisedSpec = convertSpec(
  specZ.object({ root: advertisedRoot, ...advertisedFields }).strict(),
);
/**
 * The contract and validator reject `theme: {}` and `theme.colors: {}`, but a Zod refinement has no
 * JSON Schema form, so state it on the advertised schema for schema-driven clients.
 */
function requireNonEmptyThemeObjects(spec: Record<string, unknown>): void {
  const theme = (spec.properties as Record<string, Record<string, unknown>> | undefined)?.theme;
  if (!theme) {
    return;
  }
  theme.minProperties = 1;
  const colors = (theme.properties as Record<string, Record<string, unknown>> | undefined)?.colors;
  if (colors) {
    colors.minProperties = 1;
  }
}
/**
 * Reusable components (#11053) are expanded on the host before validation, so they are not part of
 * the device spec schema; advertise the authored `components` map and `use` node here. Every
 * child slot already points at the root node schema, so a `use` fits wherever a node does.
 */
function advertiseComponents(spec: Record<string, unknown>): void {
  const properties = spec.properties as Record<string, Record<string, unknown>> | undefined;
  const root = properties?.root;
  if (!properties || !Array.isArray(root?.anyOf)) {
    return;
  }
  const name = { type: "string", pattern: STATE_KEY.source };
  root.anyOf = [
    ...(root.anyOf as unknown[]),
    {
      type: "object",
      description:
        "Replaced on the host by components[component].root with {props.<field>} bound in the fields repeat binds; a placeholder that is the whole value keeps the prop's type",
      properties: {
        type: { type: "string", enum: ["use"] },
        component: name,
        props: { type: "object", additionalProperties: { type: ["string", "number", "boolean"] } },
      },
      required: ["type", "component"],
      additionalProperties: false,
    },
  ];
  properties.components = {
    type: "object",
    description: `Reusable node templates by name, placed with {type:"use",component,props}; expanded on the host before validation (use nesting up to ${MAX_PROTOTYPE_COMPONENT_DEPTH} deep, no cycles, every prop used); limits apply to the expanded spec`,
    propertyNames: { pattern: STATE_KEY.source },
    additionalProperties: {
      type: "object",
      properties: { root: { $ref: "#/properties/spec/properties/root" } },
      required: ["root"],
      additionalProperties: false,
    },
  };
}
function rehomeSpecReferences(value: unknown): void {
  if (!value || typeof value !== "object") {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "$ref" && typeof child === "string" && child.startsWith("#")) {
      (value as Record<string, unknown>)[key] = `#/properties/spec${child.slice(1)}`;
    } else {
      rehomeSpecReferences(child);
    }
  }
}
rehomeSpecReferences(advertisedSpec);
delete advertisedSpec.$schema;
requireNonEmptyThemeObjects(advertisedSpec);
advertiseComponents(advertisedSpec);
const specDetailsSchema = specZ.object({ spec: prototypeSpecSchema });
const stateDetailsSchema = prototypeSpecSchema.pick({ state: true });

/** The first problem with an authored spec as `{path, text}`; `text` includes Zod's allowed values. */
export function specProblem(spec: unknown): { path: string; text: string } | undefined {
  const validated = validatePrototypeSpec(spec);
  if (validated.success) {
    return undefined;
  }
  const { path, message } = validated.error;
  // Nested authored values are not tool metadata. Strip only the envelope so
  // reserved names inside state remain valid user keys.
  // Zod describes the device spec, so it reads the expanded one; a component error has no Zod
  // counterpart to add.
  const expansion = expandPrototypeComponents(spec);
  const external = { spec: expansion.success ? expansion.spec : spec };
  deleteInternalToolParams(external);
  // The contract supplies deterministic paths/limits; Zod supplies allowed enum
  // values and numeric bounds. Avoid recursing into inputs that exceed limits.
  const details =
    !expansion.success || /limit|depth|budget/i.test(message)
      ? undefined
      : specDetailsSchema.safeParse(external);
  return {
    path,
    text: `${message}${details && !details.success ? `; ${details.error.message}` : ""}`,
  };
}

function specError(spec: unknown): string | undefined {
  const problem = specProblem(spec);
  return problem && `Invalid prototype at spec.${problem.path}: ${problem.text}`;
}

const specInput = withJsonSchemaOverride(
  z.unknown().superRefine((value, ctx) => {
    const error = specError(value);
    if (error) {
      ctx.addIssue({ code: "custom", message: error });
    }
  }),
  (jsonSchema) => Object.assign(jsonSchema, advertisedSpec),
);

export const dataInput = z.custom<PrototypeData>(
  (value) => prototypeDataError(value) === undefined,
);

export const stateInput = z
  .record(z.string(), z.union([z.string(), z.number().finite(), z.boolean()]))
  .superRefine((value, ctx) => {
    const external = { state: value };
    deleteInternalToolParams(external);
    if (!stateDetailsSchema.safeParse(external).success) {
      ctx.addIssue({
        code: "custom",
        message:
          "Invalid prototype at state: use flat string, number or boolean values and keys matching [A-Za-z_][A-Za-z0-9_]{0,63}",
      });
    }
  });

const assetsInput = z
  .array(
    z
      .object({
        id: z
          .string()
          .min(1)
          .max(MAX_PROTOTYPE_ASSET_ID_LENGTH)
          .describe(
            "Opaque asset id that spec image nodes reference (image.asset, or style.fontFamily {asset})",
          ),
        path: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Absolute path the daemon can read: PNG/JPEG/WebP, a TTF/OTF font (2 MiB), or Android-only AGSL .agsl source (16 KiB; AUTOMOBILE_PROTOTYPE_CUSTOM_SHADERS=1 and prototype_custom_shaders_v1 required)",
          ),
        observation: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Instead of path: an observation screenshot URI, automobile:observation/{deviceId}/{observationId}/screenshot (the observationScreenshotResourceUri that observe returns); it must still be that device's current observation",
          ),
      })
      .strict()
      .refine((entry) => (entry.path === undefined) !== (entry.observation === undefined), {
        message: "each asset needs exactly one of path or observation",
      }),
  )
  .min(1)
  .max(MAX_PROTOTYPE_ASSET_COUNT);

export const prototypeSchema = addDeviceTargetingToSchema(
  z
    .object({
      action: z.enum(
        [
          "show",
          "patch",
          "dismiss",
          "status",
          "inspect",
          "awaitEvent",
          "save",
          "listSaved",
          "deleteSaved",
          "open",
          "clearStorage",
          "simulate",
          "screenMap",
          "testSessionBegin",
          "testSessionEnd",
          "testSessionReport",
        ],
        {
          error: (issue) =>
            getRemovedToolActionHint(PROTOTYPE_TOOL_NAME, issue.input) ??
            "action must be one of show, patch, dismiss, status, inspect or awaitEvent; saved actions: save, listSaved, deleteSaved or open; storage action: clearStorage; timer action: simulate; host test-session actions: testSessionBegin, testSessionEnd or testSessionReport; host-only: screenMap",
        },
      ),
      goal: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe(
          "testSessionBegin only: screen label such as checkout/done; reaching it completes the session",
        ),
      cohort: z
        .string()
        .min(1)
        .max(64)
        .optional()
        .describe(
          "testSessionBegin only: free label echoed in the report; no cross-session aggregation",
        ),
      testSessionId: z
        .string()
        .min(1)
        .max(64)
        .optional()
        .describe("testSessionReport: stored session id, instead of the latest session for id"),
      spec: specInput
        .optional()
        .describe(
          'style.shadows, style.cornerStyle, style.border.gradient, scroll.fadeEdges and image.filter require prototype_style_polish_v2. Full prototype spec: id, window, optional theme (design material|platform, default platform; explicit platform requires prototype_design_platform_v1; mode light|dark|system, colors.seed hex or colors.source "device", plus optional per-role hex overrides in colors such as colors.primary or colors.surface applied over that scheme in light and dark, typography.scale 0.75-1.5 and fontFamily sans|serif|mono, shapes.corner none|small|medium|large|full; text style.textStyle names a Material type role such as titleLarge; style color, background and border.color take hex or a Material colour role such as primary, onSurface, surfaceContainer; style.cornerRadius takes dp, none|extraSmall|small|medium|large|extraLarge|full, or per-corner {topStart,topEnd,bottomEnd,bottomStart} dp), optional state, root. window.opacity is 0-100, default 100. window.chrome: none (default) or bar, fullscreen only: on a device advertising prototype_window_chrome_v1, none draws no host dismiss bar and fills the window including under the status bar (use safeAreaPadding on a top bar), and a two-finger long press (about 1 s) reveals a dismiss pill for 5 s; window.persistence: "device" defaults to bar. Without the capability the bar is kept, explicit none is refused, and lastResult.chrome says which was drawn. window.backdrop {material ultraThin|thin|regular|thick|glass, blur? 0-150 dp, tint? one hex or role} blurs what is behind the window and needs prototype_backdrop_v1 (refused without it); lastResult.backdrop is blur or fallback (a tonal fill where blur is unavailable). show always renders the whole spec; spec.state is authoritative. Use show for a new screen or a window, theme or root change; patch for content (/data), state (/state) or one node by id (replaceNode), requiring prototype_patch_v1. window.layer "app" and window.persistence "device" need a CtrlProxy advertising prototype_window_options_v1. Per-mode forms need a device advertising prototype_theme_modes_v1 and are refused otherwise: a colour field, gradient stop or scrim as {light, dark} (each hex or a role), a role name in a gradient stop or scrim, theme.colors.light / theme.colors.dark {role: hex} maps applied after the flat overrides for the resolved mode, and image.asset or a tabBar/bottomNav item image as {light, dark} asset ids. image.asset or an item image may instead be {data: "/pointer"} naming a device media item id in /data (prototype_platform_media_items_v1); asset ids starting with media: are reserved for the device. Stack {type:"stack",id,start,screens} requires prototype_stack_v1 and is refused otherwise. Data, repeat.items {path}, repeat.key, {data:/pointer} text and {data: pointer} conditions require prototype_data_model_v1. onLongPress/onDoubleTap on box/row/column/text/image/icon/card require prototype_gestures_v1. searchBar requires prototype_search_bar_v1 for show and patch. State-key contains/startsWith/lengthGt/lengthLt conditions and textField errorWhen/errorText require prototype_string_conditions_v1. errorWhen forces error styling without changing checks-based validity. {data: pointer, empty: true|false} conditions (missing, [], {} or "" is empty) and style shimmer on box/row/column/card require prototype_loading_states_v1. Node animate {durationMs?,easing?}, style scale (0-4)/rotation (degrees), transition slideStart|slideEnd|scale and image zoomable {maxScale 1-8} (not with onDoubleTap) require prototype_motion_v2. transition as {type, delayMs?} (0-600 ms) or blurReplace, and box/row/column stagger {ms 0-100, order? forward|reverse|center} (every child\'s total delay at most 600 ms), require prototype_choreography_v1. window.transition auto|none|fade|slide|scale and repeat.stagger (0-100 ms per instance, capped at 600 ms) require prototype_window_motion_v1 on Android. list {repeat:{items:{path},as,key},children:[row],header?,footer?,axis?,spacing?,contentPadding?,onEndReached?,endThreshold?,refresh?,maxItems?} is a lazy scrolling collection requiring prototype_lazy_list_v1 and prototype_data_model_v1. Its row template counts once, supports up to ' +
            MAX_PROTOTYPE_LIST_ITEMS +
            'shared:{key,as:"element"|"bounds"} requires prototype_shared_element_v2; sharedKey remains the v1 bounds alias; do not set both. Repeat shared.key templates need repeat.key and must reference that field. Shared pairs cannot cross dialog or bottomSheet boundaries.  keyed data rows, and refresh needs a vertical list. prependData {path,value} inserts one row at the start and requires prototype_lazy_list_v1; maxItems trims from the end. request.append {from,to} extends an existing data array from a response array; maxItems trims oldest rows atomically. String tables and {t:key|count} require prototype_strings_v1; show locale overrides device locales only for strings. Node semantics {heading,liveRegion,group,label,hint,traits} requires prototype_semantics_v1. motion: "reduced" requires prototype_reduced_motion_v1; iOS Reduce Motion selects reduced, Android animator/transition scale 0 selects off. sharedKey requires prototype_shared_element_v1; visibility morphs require visibleWhen and exactly two non-nested nodes per key, while a zoom source key names exactly one node without visibleWhen. At most 16 keys, and no repeat templates. Full motion morphs shared bounds, reduced fades, none snaps. Stack transition platform|slide|fade|none (default platform) and optional push/replace transition overrides require prototype_stack_transitions_v1; sharedAxisX|sharedAxisY|fadeThrough|zoom and push/replace source require prototype_stack_patterns_v1. Zoom needs source naming exactly one sharedKey node inside the target stack screens; prototype_zoom_transition_v1 reports native container zoom on Android and iOS 18+; older agents substitute fadeThrough on Android or platform push on iOS 17 (reported in platformNotes); pop/popToRoot take no override. Stack transition controls screen navigation, not its own visibleWhen. chart {variant line|area|bar|ring, series:[{path,x?,y,label,color?}] (1-4, each a /data array of objects with a numeric y), yRange?, xLabels?, goal?} requires prototype_chart_v1. Text nodes take exactly one of text or spans (1–64 strict {text,style?,onTap?} entries with nonempty text and inline typography/color/background only); spans require prototype_rich_text_v1, resolved span texts concatenate without separators for observe, and span taps run actions without opening URLs. Input checks, validateOn, enabledWhen, {valid: key|keys} conditions and emit.requireValid require prototype_checks_v1; see the guide for checks and formats.',
        ),
      ops: withJsonSchemaOverride(
        z.array(z.record(z.string(), z.unknown())).min(1).max(MAX_PROTOTYPE_PATCH_OPS),
        (schema) =>
          Object.assign(schema, {
            type: "array",
            minItems: 1,
            maxItems: MAX_PROTOTYPE_PATCH_OPS,
            items: {
              type: "object",
              properties: {
                op: { type: "string", enum: ["add", "replace", "remove", "test", "replaceNode"] },
                path: { type: "string" },
                value: {},
                id: { type: "string" },
                node: { type: "object" },
              },
            },
          }),
      )
        .optional()
        .describe(
          "patch only: 1–64 ordered ops on /data, /state/<key>, or replaceNode {id,node}; validated atomically before sending",
        ),
      baseRevision: z
        .number()
        .int()
        .nonnegative()
        .max(Number.MAX_SAFE_INTEGER)
        .optional()
        .describe(
          "patch only: required for /state ops, and for /data ops once the device has written the prototype's data with setData/appendData/removeData; the patch is refused with conflict if a touched key or an overlapping /data path changed since this revision",
        ),
      specPath: z
        .string()
        .min(1)
        .optional()
        .describe(
          `show only: instead of spec, an absolute path of a local JSON file holding the same spec (up to ${MAX_PROTOTYPE_SPEC_BYTES} bytes) that the daemon reads and validates like an inline spec; the path is never sent to the device. Exactly one of spec or specPath. Use it for a spec a script generated, instead of pasting the JSON into the call.`,
        ),
      display: z
        .string()
        .optional()
        .describe(
          "show only: panel key, role, or active to show the prototype on. Precedence: explicit display, then the session display pin, then the default display. Needs a CtrlProxy advertising prototype_display_id_v2; a disconnected panel is refused. Ignored, with a warning, by a same-id show without reset, which keeps the display the prototype is on.",
        ),
      replaceOthers: z
        .boolean()
        .optional()
        .describe(
          "show only: true (default) replaces other prototypes; false adds this prototype as another window (max 4 on screen; a fifth is refused listing the ones shown). A same-id show replaces only that prototype when false. Needs an Android device advertising prototype_multi_surface_v1; iOS shows one prototype at a time.",
        ),
      locale: z
        .string()
        .max(35)
        .regex(prototypeContractPatterns.localeTag)
        .optional()
        .describe(
          "show only: locale override for strings (prototype_strings_v1). Each show states it afresh; omitted uses the device preferred locales and re-resolves live. Forwarded only when spec has strings; missing translations return strings.fallback platformNotes.",
        ),
      pseudoLocale: z
        .boolean()
        .optional()
        .describe(
          "show only: true sends a pseudo-localized copy of the spec: every string-table value/plural form, semantics label/hint, text, label, placeholder, headline, title and span is accented and padded by about 40%, wrapped in [ ], with {bindings} and {t:key|count} references left intact, so truncation and clipping show without a translation. The authored spec, status and patch base are unchanged; patch ops apply to the device copy. Each show states it afresh.",
        ),
      reset: z
        .boolean()
        .optional()
        .describe(
          "show only: when the prototype with spec.id is already shown, start it fresh (pager pages from the spec, display re-resolved) instead of replacing it in place",
        ),
      appearance: z
        .enum(PROTOTYPE_APPEARANCE_INPUTS)
        .optional()
        .describe(
          'show only: what the system light/dark setting means for this prototype. device (default) follows the device; light or dark pins it without changing the device or the app behind, so a spec with theme.mode "system" or no mode can be checked in both modes. It replaces the system setting only: an explicit theme.mode, a flat theme.colors.background/surface override and an opaque authored background still decide first. Each show states it afresh (a same-id show without it follows the device again). light and dark need a device advertising prototype_appearance_v1 and are refused otherwise.',
        ),
      advanceTimeMs: z
        .number()
        .int()
        .min(1)
        .max(3600000)
        .optional()
        .describe("simulate only: advance the prototype clock without waiting"),
      id: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Prototype id required for dismiss (unless all: true), awaitEvent, deleteSaved and clearStorage; for open, the ProtoViewer library id (viewer.libraryId) a save returned",
        ),
      assets: assetsInput
        .optional()
        .describe(
          "show or save only: images to upload before the prototype is sent, as {id, path} with an absolute local file path or {id, observation} with an observation screenshot URI (PNG, JPEG or WebP, up to 4 MiB each, 16 MiB total, 32 assets). Reference each id from image nodes, or from style.fontFamily as {asset} for a TTF/OTF font file (path only, up to 2 MiB). Uploads are sequential; any failure fails the call before the prototype changes and names the assets already stored. If the device reports a supplied asset missing after the prototype is sent, it is re-uploaded and the prototype re-sent once.",
        ),
      label: z
        .string()
        .min(1)
        .max(120)
        .optional()
        .describe(
          "save only: label, defaults to spec.id; ProtoViewer takes one line without control or direction-override characters",
        ),
      icon: z
        .string()
        .min(1)
        .optional()
        .describe("save only: icon asset id uploaded in assets in this call"),
      pin: z
        .literal(true)
        .optional()
        .describe(
          "save only (Android): after saving, request a home-screen shortcut; the launcher then asks the user to confirm",
        ),
      autoConfirm: z
        .literal(true)
        .optional()
        .describe("save only: requires pin; accepts the launcher dialog, verifies the pin"),
      restartLauncher: z
        .literal(false)
        .optional()
        .describe(
          "save only (Android): false skips the automatic default-launcher restart that runs when a pinned or updated shortcut is not visible on the home screen",
        ),
      removeIcon: z
        .literal(true)
        .optional()
        .describe(
          "deleteSaved only (Android): clear CtrlProxy's shortcuts with adb when no saved prototype remains; otherwise a disabled icon remains",
        ),
      all: z.literal(true).optional().describe("Dismiss all prototypes on the targeted device"),
      eventName: z
        .string()
        .min(1)
        .optional()
        .describe(
          "awaitEvent only: filter event name; input and state changes use eventName change",
        ),
      kind: z
        .enum(PROTOTYPE_EVENT_KINDS)
        .optional()
        .describe(
          "awaitEvent only: filter event kind. screen_changed (name = stack id, payload {screen, depth}) is sent only when the top screen or depth changes. page_changed (name = pager id, payload = the new zero-based page index) is sent when a pager settles on another page. appearance_changed (name null, payload {mode, source}) is sent once whenever the shown prototype's resolved light/dark mode changes, by a device advertising prototype_appearance_v1. Input and state changes (text input, toggles, sliders etc.) arrive as kind emit with eventName change (there is no separate change kind), with payload {key,value} for one changed key or {keys,values} for several. A finished request action arrives as kind emit with eventName prototype_request",
        ),
      afterSequence: z
        .number()
        .int()
        .nonnegative()
        .max(Number.MAX_SAFE_INTEGER)
        .optional()
        .describe("awaitEvent only: return a sequence strictly above this cursor"),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          `Device request timeout; awaitEvent defaults to ${DEFAULT_PROTOTYPE_EVENT_TIMEOUT_MS} ms, maximum ${MAX_PROTOTYPE_EVENT_TIMEOUT_MS} ms; timeout is a successful empty result. save and open through ProtoViewer wait up to ${PROTOVIEWER_DEFAULT_TIMEOUT_MS} ms by default, maximum ${MAX_PROTOTYPE_EVENT_TIMEOUT_MS} ms.`,
        ),
    })
    .strict(),
).superRefine((value, ctx) => {
  const fields = [
    "spec",
    "specPath",
    "id",
    "all",
    "display",
    "reset",
    "replaceOthers",
    "locale",
    "pseudoLocale",
    "appearance",
    "eventName",
    "kind",
    "afterSequence",
    "assets",
    "ops",
    "baseRevision",
    "advanceTimeMs",
    "label",
    "icon",
    "pin",
    "autoConfirm",
    "restartLauncher",
    "removeIcon",
    "goal",
    "cohort",
    "testSessionId",
  ] as const;
  const allowed: Record<typeof value.action, readonly string[]> = {
    show: [
      "spec",
      "specPath",
      "display",
      "reset",
      "appearance",
      "assets",
      "replaceOthers",
      "locale",
      "pseudoLocale",
    ],
    patch: ["id", "ops", "baseRevision"],
    save: ["spec", "assets", "label", "icon", "pin", "autoConfirm", "restartLauncher"],
    listSaved: [],
    deleteSaved: ["id", "removeIcon"],
    open: ["id"],
    clearStorage: ["id"],
    simulate: ["id", "advanceTimeMs"],
    dismiss: ["id", "all"],
    testSessionBegin: ["id", "goal", "cohort"],
    testSessionEnd: ["id"],
    testSessionReport: ["id", "testSessionId"],
    status: [],
    inspect: [],
    screenMap: ["spec", "specPath"],
    awaitEvent: ["id", "eventName", "kind", "afterSequence"],
  };
  for (const field of fields) {
    if (value[field] !== undefined && !allowed[value.action].includes(field)) {
      ctx.addIssue({
        code: "custom",
        path: [field],
        message: `${value.action} allows ${allowed[value.action].join(", ") || "no mutation fields"}`,
      });
    }
  }
  validateTestSessionInput(value, ctx);
  validatePrototypeSavedInput(value, ctx);
  if (value.action === "patch") {
    (["id", "ops"] as const)
      .filter((field) => value[field] === undefined)
      .forEach((field) =>
        ctx.addIssue({ code: "custom", path: [field], message: "patch requires id and ops" }),
      );
  }
  validatePrototypeStorageInput(value, ctx);
  validatePrototypeSimulateInput(value, ctx);
  if (value.action === "awaitEvent") {
    validateAwaitEventInput(value, ctx);
  }
  validateProtoViewerTimeout(value, ctx);
  validateSpecSource(value, ctx);
  if (value.action === "dismiss" && (value.id === undefined) === (value.all === undefined)) {
    ctx.addIssue({
      code: "custom",
      path: ["id"],
      message: "dismiss requires exactly one of id or all: true",
    });
  }
});

function validateTestSessionInput(
  value: { action: string; id?: string; testSessionId?: string },
  ctx: z.RefinementCtx,
): void {
  if (
    ((value.action === "testSessionBegin" || value.action === "testSessionEnd") &&
      value.id === undefined) ||
    (value.action === "testSessionReport" &&
      value.id === undefined &&
      value.testSessionId === undefined)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["id"],
      message: "Test sessions require id (testSessionReport also accepts testSessionId)",
    });
  }
}

/** save and open may wait on ProtoViewer; the daemon budgets at most the awaitEvent maximum. */
function validateProtoViewerTimeout(
  value: { action: string; timeoutMs?: number },
  ctx: z.RefinementCtx,
): void {
  const waits = value.action === "save" || value.action === "open";
  if (waits && (value.timeoutMs ?? 0) > MAX_PROTOTYPE_EVENT_TIMEOUT_MS) {
    ctx.addIssue({
      code: "custom",
      path: ["timeoutMs"],
      message: `${value.action} timeoutMs must not exceed ${MAX_PROTOTYPE_EVENT_TIMEOUT_MS}`,
    });
  }
}

function validateSpecSource(value: z.infer<typeof prototypeSchema>, ctx: z.RefinementCtx): void {
  const takesSpecSource = value.action === "show" || value.action === "screenMap";
  if (takesSpecSource && (value.spec === undefined) === (value.specPath === undefined)) {
    ctx.addIssue({
      code: "custom",
      path: ["spec"],
      message:
        value.spec === undefined
          ? `${value.action} requires exactly one of spec or specPath`
          : `${value.action} takes either spec or specPath, not both`,
    });
  }
}

function validateAwaitEventInput(
  value: z.infer<typeof prototypeSchema>,
  ctx: z.RefinementCtx,
): void {
  if (value.id === undefined) {
    ctx.addIssue({ code: "custom", path: ["id"], message: "awaitEvent requires id" });
  }
  if (value.timeoutMs !== undefined && value.timeoutMs > MAX_PROTOTYPE_EVENT_TIMEOUT_MS) {
    ctx.addIssue({
      code: "custom",
      path: ["timeoutMs"],
      message: `awaitEvent timeoutMs must not exceed ${MAX_PROTOTYPE_EVENT_TIMEOUT_MS}`,
    });
  }
}

/** status and inspect show nothing on the device: reads (#10965). The rest are control. */
export const PROTOTYPE_READ_ACTIONS: readonly string[] = [
  "status",
  "inspect",
  "listSaved",
  "screenMap",
  "testSessionBegin",
  "testSessionEnd",
  "testSessionReport",
];

export function isPrototypeReadAction(args: z.infer<typeof prototypeSchema>): boolean {
  return PROTOTYPE_READ_ACTIONS.includes(args.action);
}
