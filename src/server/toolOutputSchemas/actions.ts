import { z } from "zod/v4";
import {
  pinnedDisplaySchema,
  displayInventoryUnavailableSchema,
  staleDisplaySchema,
} from "./display";
import { elementSchema, selectedElementSchema } from "./elements";
import { observationBackendFields, observationOutputSchema } from "./observation";
import { observationDiffMetadataSchema, tapEffectSchema } from "./observationMetadata";
import { platformSchema } from "../../utils/schemaHelpers";
import { FOCUS_NAVIGATE_STATUSES } from "../../features/action/FocusNavigate";

/** A successful openurl may still need a foreground confirmation before the next action. */
export const openLinkResultSchema = z
  .object({
    success: z.boolean(),
    url: z.string(),
    message: z.string(),
    error: z.string().optional(),
    warnings: z.array(z.string()).optional(),
  })
  .passthrough();

const keyboardIdentitySchema = z.object({
  component: z.string(),
  package: z.string(),
  versionName: z.string().optional(),
  subtype: z.string().optional(),
});

const imeCapabilitiesSchema = z.object({
  visibleKeyTap: z.boolean(),
  gesture: z.boolean(),
  suggestion: z.boolean(),
  clipboard: z.boolean(),
  semanticText: z.boolean(),
});

/** Keyboard has several actions; these fields describe its installed-IME results. */
export const keyboardResultSchema = z
  .object({
    method: z.enum(["escape", "dismissKey", "returnKey"]).optional(),
    installed: z
      .array(
        z
          .object({
            id: z.string(),
            enabled: z.boolean(),
            active: z.boolean(),
            capabilities: imeCapabilitiesSchema,
          })
          .passthrough(),
      )
      .optional(),
    backend: z.literal("installedIme").optional(),
    capability: z.literal("visibleKeyTap").optional(),
    keyboard: keyboardIdentitySchema.optional(),
  })
  .passthrough();

/** A command's stable failure code; the envelope repeats the failed command's code. */
const sendKeysErrorCodeSchema = z
  .string()
  .describe(
    "Stable failure code. NO_FOCUSED_EDITABLE: no editable field has focus; focus the field (tap it, or tapOn with focus), then retry sendKeys without a mode.",
  );

/** IME fields live on each command result, never on the sendKeys envelope. */
export const sendKeysResultSchema = z
  .object({
    warnings: z.array(z.string()).optional(),
    errorCode: sendKeysErrorCodeSchema.optional(),
    pinnedDisplay: pinnedDisplaySchema.optional(),
    displayInventory: displayInventoryUnavailableSchema.optional(),
    staleDisplay: staleDisplaySchema.optional(),
    commands: z
      .array(
        z
          .object({
            pinnedDisplay: pinnedDisplaySchema.optional(),
            displayInventory: displayInventoryUnavailableSchema.optional(),
            staleDisplay: staleDisplaySchema.optional(),
            errorCode: sendKeysErrorCodeSchema.optional(),
            imeFailure: z
              .object({
                stage: z.enum([
                  "unsupportedCapability",
                  "activationBinding",
                  "commit",
                  "verification",
                  "transport",
                  "restoration",
                ]),
                cause: z.string(),
                expectedText: z.string(),
                observedText: z.string().nullable(),
                focusedFieldClass: z.string().nullable(),
                textMayHaveBeenApplied: z.boolean(),
                committedUnits: z.number().int().nonnegative().optional(),
                verifiedGraphemes: z.number().int().nonnegative().optional(),
              })
              .optional(),
            imeTrace: z.array(z.string()).optional(),
            backend: z.enum(["autoMobileIme", "sdk", "xctest"]).optional(),
            fallbackReason: z.enum(["unavailable", "unsupported"]).optional(),
            capability: z.literal("semanticText").optional(),
            keyboard: keyboardIdentitySchema.optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

const tapOnSearchUntilSchema = z
  .object({
    durationMs: z.number().int(),
    requestCount: z.number().int(),
    changeCount: z.number().int(),
  })
  .passthrough();

const screenReaderNavigationSchema = z
  .object({
    reachable: z.boolean().describe("Whether the accessibility cursor was moved onto the target"),
    traversalOrder: z.array(elementSchema).describe("Focused nodes in cursor traversal order"),
    focusTrapDetected: z
      .boolean()
      .describe(
        "Always false: a cursor that cannot be moved onto the target fails the call instead",
      ),
  })
  .passthrough();

/** Shared optional action metadata, including finalized observation variants. */
export const lifecycleActionOutputFields = {
  message: z.string(),
  success: z.boolean().optional(),
  observation: observationOutputSchema.optional(),
  observationDiff: observationDiffMetadataSchema.optional(),
  effect: tapEffectSchema.optional(),
  error: z.string().optional(),
  pinnedDisplay: pinnedDisplaySchema.optional(),
  displayInventory: displayInventoryUnavailableSchema.optional(),
  staleDisplay: staleDisplaySchema.optional(),
  warnings: z.array(z.string()).optional(),
};

export const pressButtonResultSchema = z
  .object({
    ...lifecycleActionOutputFields,
    button: z.string().optional(),
    keyCode: z.number().optional(),
    code: z.string().optional(),
    retryable: z.boolean().optional(),
  })
  .passthrough();

export const wakeAndUnlockResultSchema = z
  .object({
    message: z.string(),
    success: z.boolean().optional(),
    platform: platformSchema.optional(),
    wasAsleep: z.boolean().optional(),
    wasLocked: z.boolean().optional(),
    secure: z.boolean().optional(),
    unlocked: z.boolean().optional(),
    usedRecordedCredential: z.boolean().optional(),
    error: z.string().optional(),
    warning: z.string().optional(),
  })
  .passthrough();

export const launchAppResultSchema = z
  .object({
    ...lifecycleActionOutputFields,
    packageName: z.string().optional(),
    activityName: z.string().optional(),
    userId: z.number().optional(),
    pid: z.number().optional(),
    alreadyForeground: z.boolean().optional(),
    foregroundActivityPackage: z.string().optional(),
    verifiedBy: z.string().optional(),
    verified: z.boolean().optional(),
    verifyFailureReason: z.string().optional(),
    observedAppId: z.string().optional(),
    prototypeAgent: z
      .object({
        port: z.number().int(),
        agentVersion: z.string(),
        protocolVersion: z.number().int(),
        capabilities: z.array(z.string()),
      })
      .optional(),
    observationOmitted: z
      .object({
        reason: z.literal("stale_launch_observation"),
        expectedPackage: z.string(),
        reportedPackages: z.string(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const terminateAppResultSchema = z
  .object({
    ...lifecycleActionOutputFields,
    packageName: z.string().optional(),
    wasInstalled: z.boolean().optional(),
    wasRunning: z.boolean().optional(),
    wasForeground: z.boolean().optional(),
    userId: z.number().optional(),
  })
  .passthrough();

export const tapOnResultSchema = z
  .object({
    success: z.boolean(),
    action: z.string().optional(),
    message: z.string().optional(),
    element: elementSchema.optional(),
    observation: observationOutputSchema.optional(),
    observationDiff: observationDiffMetadataSchema.optional(),
    effect: tapEffectSchema.optional(),
    selectedElement: selectedElementSchema.optional(),
    ...observationBackendFields,
    activatedSubtext: z
      .object({
        text: z.string(),
        occurrence: z.number().int().nonnegative(),
      })
      .optional()
      .describe("Semantic accessibility link confirmed by the native runner"),
    selectedElements: z.array(selectedElementSchema).optional(),
    skipped: z.literal("already-checked").optional(),
    error: z.string().optional(),
    pinnedDisplay: pinnedDisplaySchema.optional(),
    displayInventory: displayInventoryUnavailableSchema.optional(),
    staleDisplay: staleDisplaySchema.optional(),
    pressRecognized: z
      .boolean()
      .optional()
      .describe(
        "Long press heuristic: a context menu, text selection, or new window appeared. False means none was seen, not that a tap was sent",
      ),
    longClickAdvertised: z
      .boolean()
      .optional()
      .describe(
        "Android long press: whether the pressed node advertises a long-click action. False means it has no long-click handler, so the app handles the hold like a tap",
      ),
    contextMenuOpened: z.boolean().optional(),
    selectionStarted: z.boolean().optional(),
    searchUntil: tapOnSearchUntilSchema.optional(),
    screenReaderNavigation: screenReaderNavigationSchema.optional(),
    inputMethod: z
      .literal("dpad")
      .optional()
      .describe(
        "Present when the Android device has no touchscreen and the D-pad was used instead of a touch tap; enter is pressed only after focus reaches the target",
      ),
    focusNavigation: z
      .object({
        status: z.enum(FOCUS_NAVIGATE_STATUSES),
        steps: z.number(),
        path: z.array(z.record(z.string(), z.unknown())),
        focusedElement: z.record(z.string(), z.unknown()).optional(),
      })
      .passthrough()
      .optional()
      .describe("The D-pad focus walk, when inputMethod is dpad"),
    debug: z.any().optional(),
  })
  .passthrough();
