package dev.jasonpearson.automobile.desktop.core.navigation

import kotlin.math.ln

/**
 * Recency gradient for faded navigation nodes and edges (#16952).
 *
 * A node or edge that is not reached in the active context (Union lens) or not in the selected
 * build (Filter lens) fades. How far it fades depends on how recently it was last seen: the newest
 * `lastSeen` among the records that caused the fade is mapped into [[OLDEST_FADED_ALPHA],
 * [NEWEST_FADED_ALPHA]].
 * - Seen within [FRESH_WINDOW_MS] (or with a `lastSeen` in the future, from clock skew): the newest
 *   faded alpha.
 * - Seen [STALE_AFTER_MS] ago or longer (or never, `lastSeen <= 0`): the oldest faded alpha.
 * - In between: interpolated on a log scale of age, so a day, a week and a month stay distinct
 *   instead of a linear ramp crowding everything recent at the top.
 *
 * Pure: the caller supplies `nowMs` from an injected clock.
 */
object ProvenanceRecency {
  const val NEWEST_FADED_ALPHA: Float = ProvenanceOpacity.FADED_ALPHA
  const val OLDEST_FADED_ALPHA: Float = 0.25f

  const val FRESH_WINDOW_MS: Long = 24L * 60 * 60 * 1000
  const val STALE_AFTER_MS: Long = 90L * FRESH_WINDOW_MS

  /** Faded alpha for records whose newest `lastSeen` is [newestLastSeenMs], as of [nowMs]. */
  fun fadedAlpha(newestLastSeenMs: Long?, nowMs: Long): Float {
    if (newestLastSeenMs == null || newestLastSeenMs <= 0L) return OLDEST_FADED_ALPHA
    val ageMs = nowMs - newestLastSeenMs
    if (ageMs <= FRESH_WINDOW_MS) return NEWEST_FADED_ALPHA
    if (ageMs >= STALE_AFTER_MS) return OLDEST_FADED_ALPHA
    val staleness =
      (ln(ageMs.toDouble() / FRESH_WINDOW_MS) / ln(STALE_AFTER_MS.toDouble() / FRESH_WINDOW_MS))
        .toFloat()
    return NEWEST_FADED_ALPHA - (NEWEST_FADED_ALPHA - OLDEST_FADED_ALPHA) * staleness
  }

  /** [fadedAlpha] for the newest `lastSeen` among [records]. */
  fun fadedAlphaFor(records: List<ScreenProvenance>, nowMs: Long): Float =
    fadedAlpha(records.maxOfOrNull { it.lastSeen }, nowMs)
}
