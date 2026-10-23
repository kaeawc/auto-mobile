import { z } from "zod/v4";

/** Failures throw, so every storage tool result carries `success: true`. */
const storageWriteResultBase = {
  success: z.literal(true),
  appId: z.string(),
  name: z.string(),
  resolvedStore: z.string().optional(),
  warning: z.string().optional(),
};

export const setKeyValueResultSchema = z
  .object({
    ...storageWriteResultBase,
    key: z.string(),
    type: z.string(),
    effectiveValueDiffers: z.boolean().optional(),
  })
  .passthrough();

export const removeKeyValueResultSchema = z
  .object({
    ...storageWriteResultBase,
    key: z.string(),
  })
  .passthrough();

/** Non-`deleted` outcomes return `success: false` with isError; `deletedScope` is null then. */
export const deleteKeychainItemResultSchema = z
  .object({
    success: z.boolean().optional(),
    appId: z.string(),
    outcome: z.string(),
    deletedScope: z
      .object({
        itemClass: z.string(),
        service: z.string(),
        account: z.string(),
        accessGroup: z.string(),
      })
      .nullable(),
  })
  .passthrough();

export const clearKeyValueFileResultSchema = z.object(storageWriteResultBase).passthrough();

/** `stores` is the SDK adapter's own listing; its shape is owned by the adapter. */
export const listDataStoresResultSchema = z
  .object({
    success: z.literal(true),
    appId: z.string(),
    adapterName: z.string(),
    stores: z.unknown(),
  })
  .passthrough();

/** `entries` is the SDK adapter's own dump; its shape is owned by the adapter. */
export const getDataStoreResultSchema = z
  .object({
    success: z.literal(true),
    appId: z.string(),
    adapterName: z.string(),
    name: z.string(),
    entries: z.unknown(),
  })
  .passthrough();
