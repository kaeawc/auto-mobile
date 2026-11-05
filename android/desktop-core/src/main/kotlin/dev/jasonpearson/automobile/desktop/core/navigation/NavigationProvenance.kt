package dev.jasonpearson.automobile.desktop.core.navigation

/**
 * Provenance-weighted opacity + accessible provenance descriptions for the app-union navigation
 * graph (nav (app,build) Phase 2, #4985).
 *
 * A node/edge reached in the pane's [NavigationActiveContext] renders at [ACTIVE_ALPHA]; one
 * reached only historically / by another build or device fades (active wins when both). The faded
 * alpha follows the newest `lastSeen` of its records ([ProvenanceRecency], #16952): [FADED_ALPHA]
 * for something seen within a day, down to [ProvenanceRecency.OLDEST_FADED_ALPHA] for months ago.
 * The same state is surfaced as a deterministic `contentDescription` string so it is a testable,
 * accessible signal, mirroring the fog / read-only badge pattern.
 *
 * Active-context matching (design point 1): a record is active when its device matches the pane's
 * device and its build's package matches the pane's app. When the context also carries a concrete
 * [ProvenanceBuildKey] from the per-device observation stream, the version/content-hash must match
 * too. When a build key is unavailable, matching remains device+package scoped.
 *
 * Offline behavior (design point 2): with no active device there is no build to contrast against,
 * so a null context renders the whole union at [ACTIVE_ALPHA] (full opacity) rather than a uniform
 * fade — offline browse is a first-class view, not a degraded one.
 */
object ProvenanceOpacity {
  const val ACTIVE_ALPHA: Float = 1f
  const val FADED_ALPHA: Float = 0.5f

  /**
   * Non-null sentinel the ingest layer records for genuinely unknown provenance, including rows
   * written before Android/iOS build context was available. Mirrors `LEGACY_PROVENANCE_SENTINEL` in
   * NavigationGraphManager.ts.
   */
  const val LEGACY_DEVICE_SENTINEL: String = "legacy"

  /** True when [record] was observed in the pane's active [context]. */
  fun isActiveRecord(record: ScreenProvenance, context: NavigationActiveContext): Boolean {
    // A record with the unknown-device sentinel is UNCLASSIFIED, not "another device's" reach: we
    // cannot confidently fade it, so treat it as active/opaque. Android and iOS now provide build
    // context, but legacy/unknown rows still cannot be assigned to the pane's real device.
    if (record.deviceId == LEGACY_DEVICE_SENTINEL) return true
    if (record.deviceId != context.deviceId) return false
    if (record.buildKey.packageId != context.packageId) return false
    val activeBuild = context.buildKey ?: return true
    return record.buildKey == activeBuild
  }

  /**
   * Opacity for a node/edge given its [provenance] and the pane's active [context], as of [nowMs]
   * (from an injected clock). Faded records are graded by recency via [ProvenanceRecency].
   */
  fun alphaFor(
    provenance: List<ScreenProvenance>,
    context: NavigationActiveContext?,
    nowMs: Long,
  ): Float {
    if (!isFaded(provenance, context)) return ACTIVE_ALPHA
    // Faded means no record is active, so every record is a non-active one.
    return ProvenanceRecency.fadedAlphaFor(provenance, nowMs)
  }

  /** True when the node/edge is faded (reached only historically / by another build or device). */
  fun isFaded(provenance: List<ScreenProvenance>, context: NavigationActiveContext?): Boolean {
    // Offline / no active context: nothing to contrast against — show the union at full opacity.
    if (context == null) return false
    // Legacy nodes with no recorded observations cannot be classified historical; keep them opaque.
    if (provenance.isEmpty()) return false
    return provenance.none { isActiveRecord(it, context) }
  }

  /**
   * Accessible/testable provenance description for a node (or edge) labeled [label]. Encodes the
   * opacity state and, when faded, the build(s)/device(s)/session(s)/lastSeen that reached it.
   */
  fun contentDescription(
    label: String,
    provenance: List<ScreenProvenance>,
    context: NavigationActiveContext?,
  ): String =
    when {
      context == null -> "$label — union view (no active context)"
      provenance.isEmpty() -> "$label — no recorded provenance"
      provenance.any { isActiveRecord(it, context) } -> "$label — active in current context"
      else -> "$label — historical: ${formatRecords(provenance)}"
    }

  private fun formatRecords(provenance: List<ScreenProvenance>): String =
    provenance.joinToString(separator = "; ") { record ->
      val hash = record.buildKey.contentHash.ifEmpty { "no hash" }
      "build v${record.buildKey.versionCode} ($hash), device ${record.deviceId}, " +
        "session ${record.sessionUuid}, last seen ${record.lastSeen}"
    }
}
