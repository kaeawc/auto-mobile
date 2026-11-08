import { z } from "zod/v4";

/**
 * Car App Library template stacks reported by an app that integrates the AutoMobile Android SDK and
 * enabled its template route (#16751). Each template is the last one the app returned from
 * `onGetTemplate`; it says nothing about what the car host rendered.
 */

const carAppActionSchema = () =>
  z
    .object({
      id: z.string(),
      type: z.string(),
      title: z.string().optional(),
      hasIcon: z.boolean(),
      enabled: z.boolean(),
    })
    .passthrough();

const carAppItemSchema = () =>
  z
    .object({
      id: z.string(),
      kind: z.string(),
      title: z.string().optional(),
      section: z.string().optional(),
      texts: z.array(z.string()),
      hasImage: z.boolean(),
      toggle: z.boolean().optional().describe("Checked state; absent when the row has no toggle."),
      browsable: z.boolean(),
      enabled: z.boolean(),
      actions: z.array(carAppActionSchema()),
    })
    .passthrough();

const carAppActionStripSchema = () =>
  z
    .object({
      id: z.string(),
      role: z.string(),
      actions: z.array(carAppActionSchema()),
    })
    .passthrough();

const carAppTabSchema = () =>
  z
    .object({
      id: z.string(),
      contentId: z.string(),
      title: z.string().optional(),
      hasIcon: z.boolean(),
      active: z.boolean(),
    })
    .passthrough();

/** Factories, so every use is a distinct schema and the advertised JSON inlines it with no `$ref`. */
const carAppTemplateFields = () => ({
  id: z.string(),
  type: z.string(),
  title: z.string().optional(),
  loading: z.boolean().optional(),
  message: z.string().optional(),
  searchHint: z.string().optional(),
  initialSearchText: z.string().optional(),
  headerActions: z.array(carAppActionSchema()),
  items: z.array(carAppItemSchema()),
  actions: z.array(carAppActionSchema()),
  actionStrips: z.array(carAppActionStripSchema()),
  tabs: z.array(carAppTabSchema()),
});

/** The template under a `TabTemplate`'s active tab nests one level; deeper nesting is not modelled. */
const carAppTabContentSchema = () => z.object(carAppTemplateFields()).passthrough();

export const carAppTemplateSchema = () =>
  z
    .object({ ...carAppTemplateFields(), tabContent: carAppTabContentSchema().optional() })
    .passthrough();

const carAppScreenSchema = () =>
  z
    .object({
      id: z.string(),
      screenClass: z.string(),
      top: z.boolean(),
      marker: z.string().optional(),
      template: carAppTemplateSchema()
        .optional()
        .describe("Absent when the app has not recorded a template for this screen."),
    })
    .passthrough();

const carAppSessionSchema = () =>
  z
    .object({
      id: z.string(),
      screens: z.array(carAppScreenSchema()).describe("Root screen first, top screen last."),
    })
    .passthrough();

/** The SDK route's wire document. */
export const carAppTemplateDocumentSchema = z
  .object({
    schemaVersion: z.number().int().positive(),
    enabled: z.boolean(),
    sessions: z.array(carAppSessionSchema()),
    error: z.string().optional(),
  })
  .passthrough();

export const CAR_APP_TEMPLATES_NOTE =
  "Templates the app returned from onGetTemplate, not a reading of what the car host rendered.";

/** The `observe` block. */
export const carAppTemplatesSchema = z
  .object({
    packageName: z.string(),
    source: z.literal("sdk"),
    note: z.string(),
    sessions: z.array(carAppSessionSchema()),
    error: z.string().optional(),
  })
  .passthrough();

export type CarAppTemplateDocument = z.infer<typeof carAppTemplateDocumentSchema>;
export type CarAppTemplates = z.infer<typeof carAppTemplatesSchema>;

/**
 * `observe.automotive.hostRenderedUi` (#17499): the foreground UI is Car App Library templates drawn
 * by the car host, not the app's own views. `hostPackage` is present when a node carries the
 * templates host's resource-id prefix; the activity signal alone does not name the host.
 */
export interface CarAppHostRenderedUi {
  kind: "carAppLibrary";
  hostPackage?: string;
}
