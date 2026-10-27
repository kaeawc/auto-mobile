import { prototypeDegradedEffectSchema } from "../../features/prototype/prototypeDegradedEffects";
import { z } from "zod/v4";
import {
  PROTOTYPE_EVENT_KINDS,
  SAVED_PROTOTYPE_ERROR_CODES,
} from "../../features/observe/android/ctrlProxyProtocol";
import {
  PROTOTYPE_APPEARANCE_MODES,
  PROTOTYPE_APPEARANCE_SOURCES,
} from "../../features/prototype/prototypeAppearance";
import {
  MAX_PROTOTYPE_ACCESSIBILITY_FINDINGS,
  PROTOTYPE_ACCESSIBILITY_RULES,
} from "../../features/prototype/prototypeAccessibilityLint";
import { MAX_PROTOTYPE_PLACEHOLDER_FINDINGS } from "../../features/prototype/prototypePlaceholderLint";
import { reverseOutputShape } from "../prototypeReverse";
import {
  prototypeClearedOutputField,
  prototypeStorageOutputField,
} from "../prototypeStorageOutput";

export const dataOutput = z.record(z.string(), z.json()).optional();

const appearanceSchema = z.object({
  mode: z.enum(PROTOTYPE_APPEARANCE_MODES),
  source: z
    .enum(PROTOTYPE_APPEARANCE_SOURCES)
    .describe(
      "What decided the mode: explicit (theme.mode light or dark), roleLuminance (the flat theme.colors.background, else surface, override), authoredBackground (the first opaque authored background), override (the show's appearance), or system (the device's own setting)",
    ),
  deviceDark: z
    .boolean()
    .optional()
    .describe(
      "The device's own setting whatever decided mode, present only in a device answer: the show result and inspect. Absent from the host-local status action, which cannot know that the device flipped while a pinned mode stayed put; call inspect for the current value",
    ),
});
const lastResultSchema = z.object({
  id: z.string().optional(),
  all: z.literal(true).optional(),
  lastAction: z.enum(["show", "dismiss"]),
  adopted: z
    .literal(true)
    .optional()
    .describe("The device reported this prototype through inspect; this host did not show it"),
  persistent: z
    .boolean()
    .optional()
    .describe(
      "Adopted prototypes only: true when the device keeps the prototype after the host disconnects (window.persistence: device), false when it ends with the session",
    ),
  hiddenReason: z
    .enum(["app_layer_window_hidden", "device_blocked"])
    .optional()
    .describe(
      "Android: the prototype exists but is not visible, and why; absent when visible, when suspended, or with an older CtrlProxy",
    ),
  suspended: z
    .literal(true)
    .optional()
    .describe(
      "Android only: the prototype is hidden because the app it was shown over is not in front (as of the last inspect); its state is kept and it returns with the app. Absent when visible and on iOS",
    ),
  displayId: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Android logical display the prototype was shown on; absent for the default display"),
  chrome: z
    .enum(["none", "bar"])
    .optional()
    .describe(
      "show of a fullscreen window: the host chrome the device draws. none: no dismiss bar; a two-finger long press (about 1 s) reveals a dismiss pill. bar: the host dismiss bar across the top, which is what a device that does not advertise prototype_window_chrome_v1 always draws, whatever the spec default. Absent for sheet and floating windows, on dismiss and on a failed show",
    ),
  backdrop: z
    .enum(["blur", "fallback"])
    .optional()
    .describe(
      "show of a spec with window.backdrop: blur when the device blurred what is behind the window, fallback when it drew the tonal fill instead (blur unsupported or disabled). Absent without window.backdrop, on dismiss and on a failed show",
    ),
  appearance: appearanceSchema
    .optional()
    .describe(
      "The light or dark mode the prototype is drawn in, as the device last reported it: in lastResult what a successful show resolved to, and per prototype in inspect that value, and in status its mode and source as refreshed by inspect and by appearance_changed events (status never carries deviceDark; after a show crossed by an appearance_changed event, its status entry has no appearance until a later event or inspect states it). Absent when the device does not advertise prototype_appearance_v1, on dismiss and on a failed show",
    ),
  degradedEffects: z.array(prototypeDegradedEffectSchema).optional(),
  warning: z
    .string()
    .optional()
    .describe("Effects omitted or frozen by the device, with their paths and reasons"),
  storage: prototypeStorageOutputField,
  shaderFailures: z.record(z.string(), z.string()).optional(),
  timers: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        nextFireInMs: z.number().int().safe().nonnegative(),
        runs: z.number().int().safe().nonnegative(),
      }),
    )
    .max(8)
    .optional(),
  success: z.boolean(),
  error: z.string().optional(),
  totalTimeMs: z.number().optional(),
  timestamp: z.number().describe("Host clock milliseconds when the request completed"),
});
const eventCountsSchema = z.object({
  pendingCount: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Unconsumed events, including events excluded by filters or cursor"),
  lastSequence: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Highest sequence accepted for this prototype"),
  droppedCount: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Cumulative events dropped by buffer overflow in this scope"),
});
const prototypeEventOutputSchema = z.object({
  id: z.string(),
  sequence: z.number().int().nonnegative(),
  kind: z.enum(PROTOTYPE_EVENT_KINDS),
  name: z.string().nullable(),
  payload: z.json(),
  context: z.record(z.string(), z.json()).and(z.unknown()).optional(),
  contextTruncated: z.literal(true).optional(),
  state: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  pages: z.record(z.string(), z.number().int().nonnegative()),
  stacks: z
    .record(
      z.string(),
      z.object({
        path: z.array(z.string().min(1)).min(1).max(32),
        depth: z.number().int().min(1).max(32),
      }),
    )
    .optional(),
  validity: z.record(z.string(), z.boolean()).optional(),
  keys: z.array(z.string()).min(1).max(8).optional(),
  timestamp: z.number(),
});
export const prototypeOutputSchema = z.object({
  screenMap: z
    .object({
      nodes: z.array(
        z.object({
          id: z.string(),
          kind: z.enum(["root", "stackScreen", "pagerPage", "sheet", "dialog"]),
          path: z.string(),
          label: z.string().optional(),
          start: z.literal(true).optional(),
        }),
      ),
      edges: z.array(
        z.object({
          from: z.string(),
          to: z.string(),
          action: z.enum(["push", "replace", "pop", "popToRoot", "setPage"]),
          trigger: z.object({
            path: z.string(),
            testTag: z.string().optional(),
            id: z.string().optional(),
            label: z.string().optional(),
          }),
        }),
      ),
    })
    .optional()
    .describe("screenMap only: the spec's screens and the actions that move between them"),
  mermaid: z.string().optional().describe("screenMap only: the same map as a Mermaid flowchart"),
  testSession: z
    .object({
      id: z.string(),
      status: z.enum(["active", "ended"]),
      prototypeId: z.string(),
      deviceId: z.string(),
      cohort: z.string().optional(),
      goal: z.string().optional(),
      startedAt: z.number(),
      endedAt: z.number().optional(),
      eventCount: z.number().int().nonnegative(),
      droppedCount: z.number().int().nonnegative(),
      deadTaps: z.enum(["enabled", "off"]),
    })
    .optional(),
  report: z.json().optional(),
  markdown: z.string().optional(),
  saved: z.object({ id: z.string(), slug: z.string(), replaced: z.boolean() }).optional(),
  viewer: z
    .object({
      app: z.literal("protoviewer"),
      libraryId: z.string().describe("Pass as id to open to launch this entry."),
      label: z.string(),
    })
    .optional()
    .describe(
      "save and open on Android or an iOS simulator with ProtoViewer installed: the ProtoViewer library entry. The entry is imported: ProtoViewer sets its source, keeps its network off until the user allows it, and it is not attached to this host.",
    ),
  savedPrototypes: z
    .array(
      z.object({
        id: z
          .string()
          .describe(
            "Authored prototype id on Android; bundle id on iOS simulators, accepted by deleteSaved.",
          ),
        label: z.string(),
        slug: z.string(),
        savedAt: z
          .number()
          .finite()
          .optional()
          .describe("Absent where the platform cannot report save time (iOS simulators)."),
        pinned: z.boolean(),
      }),
    )
    .optional(),
  pinned: z.enum(["pinned", "pending", "unsupported"]).optional(),
  launcherRestarted: z
    .boolean()
    .optional()
    .describe(
      "Android save with pin: true when the default launcher was restarted to show the shortcut.",
    ),
  shortcutVisible: z
    .boolean()
    .optional()
    .describe("Android: whether the shortcut was seen on the home screen after a pin or update."),
  errorCode: z
    .enum([...SAVED_PROTOTYPE_ERROR_CODES, "unsupported_capability", "unsupported_platform"])
    .optional(),
  revision: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .optional()
    .describe("patch only: current device revision after applying or refusing a patch"),
  conflict: z
    .object({
      revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      state: z.record(z.string(), z.union([z.string(), z.number().finite(), z.boolean()])),
      data: z
        .array(z.string())
        .max(64)
        .optional()
        .describe(
          "/data paths a newer device write (setData, appendData, prependData, removeData) touched",
        ),
    })
    .strict()
    .optional()
    .describe(
      "patch only: newer user edits or device /data writes that refused the whole patch, with current revision and touched state values or data paths",
    ),
  cleared: prototypeClearedOutputField,
  fired: z.number().int().min(0).max(10000).optional(),
  success: z.boolean(),
  error: z.string().optional(),
  prototypes: z
    .array(
      lastResultSchema.extend(eventCountsSchema.shape).extend({
        pages: z.record(z.string(), z.number().int().nonnegative()).optional(),
        stacks: z
          .record(
            z.string(),
            z.object({
              path: z.array(z.string().min(1)).min(1).max(32),
              depth: z.number().int().min(1).max(32),
            }),
          )
          .optional()
          .describe("Last reported stack paths and depths; absent when the device reports none"),
        state: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
        data: dataOutput,
        context: prototypeEventOutputSchema.shape.context,
        contextTruncated: prototypeEventOutputSchema.shape.contextTruncated,
        lastKnown: z
          .literal(true)
          .optional()
          .describe(
            "Pages, stacks and state are the last reported device snapshot, not a live device query",
          ),
      }),
    )
    .optional(),
  lastResult: lastResultSchema.optional(),
  platformNotes: z
    .array(
      z.object({
        platform: z.enum(["android", "ios", "all"]),
        construct: z.enum([
          "stack",
          "carousel",
          "node.id",
          "bottomSheet.dismissOnSwipe",
          "bottomSheet.detents",
          "icon.effect",
          "icon.name",
          "icon.variant",
          "textField.variant",
          "textField.label",
          "node.gestures",
          "searchBar",
          "searchBar.icons",
          "rich-text-links",
          "strings.fallback",
          "design.fallback",
          "platformNamespace",
          "menu",
          "select",
        ]),
        effect: z.enum(["ignored", "substituted"]),
        paths: z.array(z.string()).max(20),
        total: z.number().int().positive().optional(),
        values: z.array(z.string()).optional(),
        detail: z.string(),
      }),
    )
    .optional()
    .describe(
      "Successful show on either platform (legacy renderer differences apply to iOS only): strings.fallback applies to all platforms, lists locale and up to 20 referenced keys falling through to default (values), with paths strings.default.<key>; other notes describe platform differences: platform and construct identify the difference; effect says ignored or substituted; paths list affected fields in the component-expanded, anchor-resolved device spec in tree order, capped at 20, including bottomSheet.dismissOnSwipe when absent and defaulted; total is the full count only when capped; values are distinct sorted placeholder icon names for icon.name; detail explains iOS and Android behavior. Absent when nothing applies or the show failed.",
    ),
  accessibilityFindings: z
    .array(
      z.object({
        rule: z.enum(PROTOTYPE_ACCESSIBILITY_RULES),
        path: z.string(),
        detail: z.string(),
        mode: z.enum(["light", "dark"]).optional(),
        value: z.number().optional(),
        minimum: z.number().optional(),
      }),
    )
    .max(MAX_PROTOTYPE_ACCESSIBILITY_FINDINGS)
    .optional()
    .describe(
      "Successful show or patch: advisory accessibility lint of the device spec (never refuses a show). rule is unlabeled-control, unlabeled-image, unlabeled-text-field, low-contrast (authored text colour vs. its resolved background, per light/dark mode, WCAG AA), small-touch-target (authored size under 48dp), missing-translation, unknown-translation-key, empty-heading or transition-without-visible-when (a node transition with no visibleWhen, which never runs); path is the node in the component-expanded device spec; value/minimum give the ratio or dp. Absent when nothing is found.",
    ),
  accessibilityFindingsTotal: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Total accessibility findings, present only when accessibilityFindings was capped"),
  placeholderFindings: z
    .array(
      z.object({
        path: z.string(),
        placeholder: z.string(),
        detail: z.string(),
      }),
    )
    .max(MAX_PROTOTYPE_PLACEHOLDER_FINDINGS)
    .optional()
    .describe(
      "Successful show or patch: advisory lint for a repeat or state placeholder in a field that does not bind it, so it would be drawn literally (for example chip.label, badge.text, textField.placeholder). path is the field in the component-expanded device spec; placeholder is the text as authored. Never refuses a show. Absent when nothing is found.",
    ),
  placeholderFindingsTotal: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Total placeholder findings, present only when placeholderFindings was capped"),
  event: prototypeEventOutputSchema.optional(),
  timedOut: z
    .literal(true)
    .optional()
    .describe("awaitEvent reached its timeout without a matching event; success remains true"),
  reason: z
    .literal("dismissed")
    .optional()
    .describe("The prototype scope ended without a matching event"),
  uploadedAssets: z
    .array(z.object({ id: z.string(), mimeType: z.string(), bytes: z.number().int().positive() }))
    .optional()
    .describe(
      "show or save with assets: assets the device confirmed, also present on failure. They stay on the device until the prototype session ends.",
    ),
  degradedEffects: z.array(prototypeDegradedEffectSchema).optional(),
  missingAssets: z
    .array(z.string())
    .optional()
    .describe(
      "show: asset ids the prototype references that the device has no copy of; the prototype is shown with placeholders. Absent when none. Upload them with assets on a show.",
    ),
  visible: z
    .literal(false)
    .optional()
    .describe(
      "Android show: no prototype window was on screen after an app-layer show, or the device reports device_blocked for any layer; absent when visible or not checked",
    ),
  notVisibleReason: z
    .enum(["no_prototype_window_on_screen", "app_layer_window_hidden", "device_blocked"])
    .optional()
    .describe(
      "Android show: why visible is false. app_layer_window_hidden: the app in front hides app-layer windows; device_blocked: the device is locked or its screen is off. no_prototype_window_on_screen: older-device app-layer confirmation found no window on screen; absent when visible or not checked",
    ),
  warning: z
    .string()
    .optional()
    .describe(
      "show or patch succeeded or awaitEvent timed out, and it needs attention: reports degraded effects with paths and api/budget reasons, names what to do about missingAssets, that display was ignored by a same-id show, that an Android app-layer prototype is not on screen, or (awaitEvent timeout) that the prototype is hidden because its app is not in front",
    ),
  anchors: z
    .array(
      z.object({
        path: z.string(),
        alignment: z.enum(["cover", "top", "bottom", "start", "end"]),
        boundsPx: z.object({
          left: z.number(),
          top: z.number(),
          right: z.number(),
          bottom: z.number(),
        }),
        bounds: z.object({
          x: z.number(),
          y: z.number(),
          width: z.number(),
          height: z.number(),
        }),
      }),
    )
    .optional()
    .describe(
      "show with element anchors: each anchored node's path and the app element bounds it was resolved to, as observe reports them (boundsPx: px on Android, points on iOS) and in spec units (bounds: dp on Android, points on iOS). Resolved once at show; the prototype does not follow later scrolling or layout, so show again to re-anchor.",
    ),
  hierarchyUpdatedAt: z
    .number()
    .optional()
    .describe(
      "show with element anchors: device timestamp of the hierarchy they were resolved against",
    ),
  ...reverseOutputShape,
  deviceDroppedEvents: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      "inspect only: events the device dropped from its offline buffer (200 per device) since CtrlProxy started; a gap in sequences shows which",
    ),
  ...eventCountsSchema.shape,
});
