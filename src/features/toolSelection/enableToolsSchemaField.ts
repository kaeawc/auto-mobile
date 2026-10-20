import { z } from "zod/v4";

/**
 * #6869 — the `enableTools` request field shared by the device-acquisition
 * tools (`getAndroid`, `getApple`, `provisionDevice`), which apply it while
 * minting the session so acquisition and capability declaration are one call.
 * Same vocabulary and same validation as `setToolEnabled`'s `toolNames`.
 */
export const enableToolsSchemaField = z
  .array(z.string().min(1))
  .min(1)
  .optional()
  .describe(
    "Exact case-sensitive AutoMobile tool names to enable for the session this call mints, " +
      "applied before the response is built so the returned enabledTools/gatedTools reflect discovery. " +
      "Unknown or hidden names reject the call before device work; always-on names are returned in skipped.",
  );
