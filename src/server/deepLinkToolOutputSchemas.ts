import { z } from "zod/v4";

const intentFilterSchema = z
  .object({
    action: z.string(),
    category: z.array(z.string()),
    data: z
      .array(
        z
          .object({
            scheme: z.string().optional(),
            host: z.string().optional(),
            port: z.string().optional(),
            path: z.string().optional(),
            pathPattern: z.string().optional(),
            pathPrefix: z.string().optional(),
            mimeType: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

/** One web domain's Android App Links state (#14110). */
export const appLinkDomainStateSchema = z
  .object({
    domain: z.string(),
    state: z.string().optional(),
    autoVerify: z.boolean(),
    userSelected: z.boolean(),
    approvedForLinks: z.boolean(),
  })
  .passthrough();

/** `success: false` is returned with `isError`, so both outcomes carry this shape. */
export const getDeepLinksResultSchema = z
  .object({
    message: z.string(),
    success: z.boolean(),
    appId: z.string(),
    schemes: z.array(z.string()),
    hosts: z.array(z.string()),
    intentFilters: z.array(intentFilterSchema),
    supportedMimeTypes: z.array(z.string()),
    appLinks: z.array(appLinkDomainStateSchema).optional(),
    appLinksUserId: z.number().int().optional(),
    appLinkHandlingAllowed: z.boolean().optional(),
    appLinksUnavailable: z.string().optional(),
    note: z.string().optional(),
    error: z.string().optional(),
    rawOutput: z.string().optional(),
  })
  .passthrough();

const appLinkDomainSnapshotSchema = z
  .object({ state: z.string().optional(), userSelected: z.boolean() })
  .passthrough();

/** `setAppLinks` result (#14110): what changed, the state after, and the restore receipt. */
export const setAppLinksResultSchema = z
  .object({
    message: z.string(),
    success: z.boolean(),
    appId: z.string(),
    userId: z.number().int(),
    action: z.string(),
    changed: z.array(
      z
        .object({
          domain: z.string(),
          before: appLinkDomainSnapshotSchema,
          after: appLinkDomainSnapshotSchema,
        })
        .passthrough(),
    ),
    unapplied: z.array(z.string()).optional(),
    skipped: z
      .array(z.object({ domain: z.string(), state: z.string(), reason: z.string() }).passthrough())
      .optional(),
    appLinks: z.array(appLinkDomainStateSchema),
    appLinkHandlingAllowed: z.boolean().optional(),
    restore: z
      .object({
        onSessionRelease: z.boolean(),
        verification: z
          .array(
            z
              .object({
                domain: z.string(),
                original: z.string(),
                restoreAs: z.string(),
                exact: z.boolean(),
              })
              .passthrough(),
          )
          .optional(),
        userSelections: z
          .array(z.object({ userId: z.number().int(), enabled: z.array(z.string()) }).passthrough())
          .optional(),
      })
      .passthrough()
      .optional(),
    note: z.string().optional(),
  })
  .passthrough();
