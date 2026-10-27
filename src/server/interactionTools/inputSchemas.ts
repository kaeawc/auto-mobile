import { z } from "zod/v4";
import { INPUT_KEY_MODIFIERS, SUPPORTED_INPUT_KEYS } from "../../features/action/InputKey";
import { KEYBOARD_PROFILE_IDS } from "../../features/action/keyboardProfiles";
import {
  SEND_KEYS_CLEAR_MODES,
  SEND_KEYS_MAX_COMMANDS,
  SEND_KEYS_MAX_MODIFIERS,
  SEND_KEYS_OPERATIONS,
  SEND_KEYS_SEMANTIC_KEYS,
  SEND_KEYS_TYPING_MODES,
} from "../../features/action/SendKeys";
import {
  hierarchyLayerSchema,
  nestedElementContainerSchema,
  resolverSelectionStrategySchema,
} from "../../models/elementSelectorSchemas";
import {
  addDeviceTargetingToSchema,
  platformSchema,
  responseShapeControlFields,
  withCanonicalDiscriminatedUnionJsonSchema,
  withJsonSchemaOverride,
} from "../../utils/schemaHelpers";

// A selector focuses the target field before typing (issue #5872 AC3), so a
// form field no longer costs a mandatory tapOn-then-sendKeys pair. Kept to the
// selector variants that identify an input; semantic-link activation is a tapOn
// concern, not a field to type into.
const sendKeysSelectorSchema = z
  .union([
    z
      .object({ elementId: z.string().min(1).describe("Resource ID, e.g. com.app:id/field") })
      .strict(),
    z.object({ testTag: z.string().min(1).describe("Android accessibility test tag") }).strict(),
    z
      .object({
        text: z.string().min(1).describe("Text, content-desc, or placeholder of the field"),
      })
      .strict(),
    z
      .object({
        textAny: z
          .array(z.string().min(1))
          .min(1)
          .describe("Ordered text variants; first visible match wins"),
      })
      .strict(),
  ])
  .describe(
    "Field to focus before typing: elementId, Android testTag, text, or ordered text variants",
  );

const sendKeysKeyValues = [...SUPPORTED_INPUT_KEYS, ...SEND_KEYS_SEMANTIC_KEYS] as const;

const sendKeysTypeCommandSchema = withJsonSchemaOverride(
  z
    .object({
      action: z.literal("type"),
      text: z.string().min(1).describe("Text to insert or replace; never echoed in the result"),
      operation: z
        .enum(SEND_KEYS_OPERATIONS)
        .default("insert")
        .describe("Insert at the current selection (default) or replace the focused field"),
      mode: z
        .enum(SEND_KEYS_TYPING_MODES)
        .default("auto")
        .describe(
          "Android delivery mode. Use ime, a11y, or auto for Unicode and emoji. auto uses the AutoMobile IME when supported, otherwise eventAll for insert or a11y for replace. ime commits complete graphemes; eventAll inserts whole graphemes and uses key events only for single printable ASCII characters. eventLast can split keycaps or decomposed letters. eventOnly and imeKeyEvents are ASCII-only; imeKeyEvents requires a compatible CtrlProxy APK and does not verify resulting editor text. iOS uses xcuiTypeText for every requested mode",
        ),
      keyboardProfile: z
        .enum(KEYBOARD_PROFILE_IDS)
        .optional()
        .describe("Android keyboard behavior profile for this IME type call; restored afterward"),
    })
    .strict()
    .superRefine((command, context) => {
      if (command.keyboardProfile && command.mode !== "auto" && command.mode !== "ime") {
        context.addIssue({
          code: "custom",
          path: ["mode"],
          message: "keyboardProfile requires mode: ime or auto",
        });
      }
    }),
  (jsonSchema) => {
    jsonSchema.dependentSchemas = {
      ...(jsonSchema.dependentSchemas as Record<string, unknown> | undefined),
      keyboardProfile: {
        properties: { mode: { enum: ["auto", "ime"] } },
      },
    };
  },
);

const sendKeysCommandSchema = withCanonicalDiscriminatedUnionJsonSchema(
  z.discriminatedUnion("action", [
    sendKeysTypeCommandSchema,
    z
      .object({
        action: z.literal("key"),
        key: z
          .enum(sendKeysKeyValues)
          .describe(
            "Raw key or semantic IME key. Semantic next/previous/done/search/send/go ignore modifiers",
          ),
        modifiers: z
          .array(z.enum(INPUT_KEY_MODIFIERS))
          .max(SEND_KEYS_MAX_MODIFIERS)
          .optional()
          .describe(
            `Raw-key modifier chord: shift, ctrl, alt, or meta (maximum ${SEND_KEYS_MAX_MODIFIERS} entries, including duplicates)`,
          ),
      })
      .strict(),
    z
      .object({
        action: z.literal("clear"),
        mode: z
          .enum(SEND_KEYS_CLEAR_MODES)
          .optional()
          .describe(
            "Android clear delivery. auto (default) and ime clear through the AutoMobile IME, or key-event deletes on an older control-proxy APK or when the IME cannot be activated, so rich-text editors keep live formatting. a11y uses the accessibility set-text clear. iOS ignores this",
          ),
      })
      .strict(),
  ]),
);

export const sendKeysSchema = withJsonSchemaOverride(
  addDeviceTargetingToSchema(
    z
      .object({
        display: z.string().optional().describe("Target panel key, role, or active"),
        selector: sendKeysSelectorSchema
          .optional()
          .describe(
            "Field to focus once before executing the ordered command sequence; supports nested container scope and unique selection",
          ),
        container: nestedElementContainerSchema
          .optional()
          .describe(
            "Nested container scope; outermost resolves first, each level searches strict descendants. Per-level index is zero-based. Requires a selector naming the field to focus.",
          ),
        selectionStrategy: resolverSelectionStrategySchema
          .optional()
          .describe(
            "Selection strategy: first (default), random, or unique. Unique requires exactly one match at every unindexed scope and target. Requires a selector naming the field to focus.",
          ),
        layer: hierarchyLayerSchema.optional(),
        commands: z
          .array(sendKeysCommandSchema)
          .min(1)
          .max(SEND_KEYS_MAX_COMMANDS)
          .describe(
            `One to ${SEND_KEYS_MAX_COMMANDS} commands executed serially; execution stops on the first failure`,
          ),
        // #5870: Device or session targeting resolves the platform.
        platform: platformSchema.optional(),
        ...responseShapeControlFields,
      })
      .strict(),
  ).superRefine((value, ctx) => {
    if (value.selector !== undefined) {
      return;
    }
    for (const field of ["container", "selectionStrategy", "layer"] as const) {
      if (value[field] !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${field} requires a selector naming the field to focus`,
          path: [field],
        });
      }
    }
  }),
  (jsonSchema) => {
    jsonSchema.dependentRequired = {
      container: ["selector"],
      selectionStrategy: ["selector"],
      layer: ["selector"],
    };
  },
);

const clipboardTextRequiredMessage = "text is required when action is copy";

const optionalClipboardTextSchema = z
  .string()
  .min(1)
  .optional()
  .describe("Text to copy (required for 'copy' action)");

const clipboardPlatformSchema = {
  // #5870: a `sessionUuid`/`deviceId` resolves the platform, so `platform` is
  // not required — a device handle from getAndroid/getApple is sufficient on
  // its own.
  platform: platformSchema.optional(),
};

export const clipboardSchema = z.discriminatedUnion("action", [
  addDeviceTargetingToSchema(
    z
      .object({
        action: z.literal("copy").describe("Clipboard action"),
        text: z
          .string({ error: clipboardTextRequiredMessage })
          .min(1, clipboardTextRequiredMessage)
          .describe("Text to copy (required for 'copy' action)"),
        ...clipboardPlatformSchema,
      })
      .strict(),
  ),
  addDeviceTargetingToSchema(
    z
      .object({
        action: z.literal("paste").describe("Clipboard action"),
        text: optionalClipboardTextSchema,
        ...clipboardPlatformSchema,
      })
      .strict(),
  ),
  addDeviceTargetingToSchema(
    z
      .object({
        action: z.literal("clear").describe("Clipboard action"),
        text: optionalClipboardTextSchema,
        ...clipboardPlatformSchema,
      })
      .strict(),
  ),
  addDeviceTargetingToSchema(
    z
      .object({
        action: z.literal("get").describe("Clipboard action"),
        text: optionalClipboardTextSchema,
        ...clipboardPlatformSchema,
      })
      .strict(),
  ),
]);
