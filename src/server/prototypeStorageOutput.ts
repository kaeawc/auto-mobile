import { z } from "zod/v4";

/** The output shape of `PrototypeStorageReport` in `inspect` and `status` (#12522). */
const prototypeStorageReportSchema = z.object({
  version: z.number().int().min(1).describe("The storage.version the device stores values under"),
  keys: z
    .array(z.object({ key: z.string(), bytes: z.number().int().nonnegative() }))
    .describe(
      "Stored keys that currently hold a value (state:<key> or data:<pointer>) and the bytes each occupies",
    ),
  totalBytes: z.number().int().nonnegative(),
  skippedKeys: z
    .array(z.string())
    .optional()
    .describe("Keys whose latest value was not stored because it would exceed the byte limit"),
});

/** `storage` on a prototype entry (`inspect`, `status`). */
export const prototypeStorageOutputField = prototypeStorageReportSchema
  .optional()
  .describe(
    "inspect only: what the device has stored for this prototype's storage block (prototype_storage_v1), as the device last reported it. Absent when the device does not report it or the prototype has no storage block",
  );

/** `cleared` on a `clearStorage` result. */
export const prototypeClearedOutputField = z
  .number()
  .int()
  .nonnegative()
  .optional()
  .describe(
    "clearStorage only: how many stored keys the device removed (0 when nothing was stored); absent when the device did not say",
  );
