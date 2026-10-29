import { z } from "zod";

/**
 * Host-side model of the iOS SDK WKWebView bridge's values (#5162). The Swift source of truth is
 * `WebViewWireModels.swift` in `ios/sdk-wire`; CtrlProxy relays them in `sdk_web_snapshot_result`
 * and `sdk_web_action_result`.
 */

export const iosSdkWebElementSchema = z.object({
  id: z.string(),
  role: z.string().optional(),
  label: z.string().optional(),
  /** Redacted to `[REDACTED]` by the bridge when its policy redacts text. */
  value: z.string().optional(),
  /** `[x, y, width, height]` in the page's CSS pixels; empty when the page reported none. */
  bounds: z.array(z.number()),
  enabled: z.boolean(),
  visible: z.boolean(),
  focused: z.boolean(),
});
export type IosSdkWebElement = z.infer<typeof iosSdkWebElementSchema>;

/** A bounded, redacted DOM snapshot. Element ids are valid only for this snapshot. */
export const iosSdkWebSnapshotSchema = z.object({
  snapshotId: z.string(),
  url: z.string().optional(),
  title: z.string().optional(),
  elements: z.array(iosSdkWebElementSchema),
});
export type IosSdkWebSnapshot = z.infer<typeof iosSdkWebSnapshotSchema>;

/** One opted-in web view, as the app's SDK reports it. */
export const iosSdkWebViewEntrySchema = z.object({
  webViewId: z.string(),
  url: z.string().optional(),
  allowedOrigins: z.array(z.string()),
  contentProcessAvailable: z.boolean(),
});
export type IosSdkWebViewEntry = z.infer<typeof iosSdkWebViewEntrySchema>;
export const iosSdkWebViewsSchema = z.array(iosSdkWebViewEntrySchema);

export const iosSdkWebActionResultSchema = z.object({
  status: z.enum(["accepted", "rejected"]),
  /** `stale_snapshot`, `element_not_actionable`, `disallowed_origin`, `web_process_unavailable` or `javascript_error`. */
  reason: z.string().optional(),
});
export type IosSdkWebActionResult = z.infer<typeof iosSdkWebActionResultSchema>;

/**
 * One bounded web action, in Swift's synthesized `Codable` enum shape: the case name keys an object
 * of its labeled values. Every action names the snapshot its element came from. There is no
 * JavaScript action: the runner rejects anything outside this set as `invalid_action`.
 */
export type IosSdkWebAction =
  | { click: { snapshotId: string; elementId: string } }
  | { focus: { snapshotId: string; elementId: string } }
  | { insertText: { snapshotId: string; elementId: string; text: string } }
  | { select: { snapshotId: string; elementId: string; value: string } }
  | { scroll: { snapshotId: string; elementId?: string; x: number; y: number } }
  | { setValue: { snapshotId: string; elementId: string; text: string } }
  | { clear: { snapshotId: string; elementId: string } }
  | { scrollIntoView: { snapshotId: string; elementId: string } }
  | { submit: { snapshotId: string; elementId: string } };

/** Typed reasons a web-view command produced no result. */
export const IOS_SDK_WEB_FAILURES = [
  "bridge_unavailable",
  "app_not_active",
  "invalid_action",
  "bad_reply",
  "disallowed_origin",
  "web_process_unavailable",
  "message_too_large",
  "no_snapshot",
] as const;
export type IosSdkWebFailure = (typeof IOS_SDK_WEB_FAILURES)[number];

/** Narrow a runner failure code; one this daemon does not know reads as `bad_reply`. */
export function iosSdkWebFailure(value: unknown): IosSdkWebFailure | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return IOS_SDK_WEB_FAILURES.find((known) => known === value) ?? "bad_reply";
}
