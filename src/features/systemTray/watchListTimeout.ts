/**
 * Scan deadline for a watch `list` called without `awaitTimeout`. A loaded host takes 1.5 to 2 s
 * per scroll page, so the 5 s tray default covers only a few pages; this fits about 15, a full
 * scroll of a typical stream (#17386).
 */
export const WATCH_LIST_SCAN_TIMEOUT_MS = 30_000;

/**
 * Request-budget allowance on top of a `list` scan deadline: app inventory, opening and rewinding
 * the stream, restoring the previous screen and result serialization.
 */
export const SYSTEM_TRAY_LIST_MCP_TIMEOUT_HEADROOM_MS = 30_000;

/** Why a watch `list` scan stopped before the end of the stream. */
export type ListCutShort = "deadline" | "page_limit" | "rewind";

const CUT_SHORT_MESSAGES: Record<ListCutShort, string> = {
  deadline: "the scan deadline passed",
  page_limit: "the scan page limit was reached",
  rewind: "the stream could not be scrolled back to its top",
};

/** A watch `list` result message, saying why when the scan was cut short. */
export function listMessage(count: number, appId: string | undefined, cutShort?: ListCutShort) {
  const listed = `Listed ${count} notifications for ${appId}`;
  return cutShort
    ? `${listed}; the stream may hold more: ${CUT_SHORT_MESSAGES[cutShort]}. Retry with a larger awaitTimeout to read the whole stream.`
    : listed;
}
