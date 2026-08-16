package dev.jasonpearson.automobile.desktop.core.navigation

/**
 * Provenance-weighted opacity + accessible provenance descriptions for the app-union navigation
 * graph (nav (app,build) Phase 2, #4985).
 *
 * A node/edge reached in the pane's [NavigationActiveContext] renders at [ACTIVE_ALPHA]; one
 * reached only historically / by another build or device renders at [FADED_ALPHA] (active wins when
 * both). The same state is surfaced as a deterministic `contentDescription` string so it is a
 * testable, accessible signal, mirroring the fog / read-only badge pattern.
 *
 * Active-context matching (design point 1): a record is active when its device matches the pane's
 * device and its build's package matches the pane's app. When the context also carries a concrete
 * [ProvenanceBuildKey] the version/content-hash must match too; until the build discriminator is
 * threaded through the navigation stream (deferred #4837) the context build key is null and
 * matching is device+package scoped.
 *
 * Offline behavior (design point 2): with no active device there is no build to contrast against,
 * so a null context renders the whole union at [ACTIVE_ALPHA] (full opacity) rather than a uniform
 * fade — offline browse is a first-class view, not a degraded one.
 */
object ProvenanceOpacity {
  const val ACTIVE_ALPHA: Float = 1f
  const val FADED_ALPHA: Float = 0.5f

  /**
   * Non-null sentinel the ingest layer records for a provenance dimension it cannot resolve — e.g.
   * iOS events carry no build context yet (deferred #4991), so their device is this sentinel.
   * Mirrors `LEGACY_PROVENANCE_SENTINEL` in NavigationGraphManager.ts.
   */
  const val LEGACY_DEVICE_SENTINEL: String = "legacy"

  /** True when [record] was observed in the pane's active [context]. */
  fun isActiveRecord(record: ScreenProvenance, context: NavigationActiveContext): Boolean {
    // A record with the unknown-device sentinel is UNCLASSIFIED, not "another device's" reach: we
    // cannot confidently fade it, so treat it as active/opaque. Without this the whole iOS graph —
    // whose events always carry the legacy device until eager build-context (deferred #4991) —
    // would render 50% faded, because none of its nodes match the pane's real device.
    if (record.deviceId == LEGACY_DEVICE_SENTINEL) return true
    if (record.deviceId != context.deviceId) return false
    if (record.buildKey.packageId != context.packageId) return false
    val activeBuild = context.buildKey ?: return true
    return record.buildKey.versionCode == activeBuild.versionCode &&
      record.buildKey.contentHash == activeBuild.contentHash
  }

  /** Opacity for a node/edge given its [provenance] and the pane's active [context]. */
  fun alphaFor(provenance: List<ScreenProvenance>, context: NavigationActiveContext?): Float {
    // Offline / no active context: nothing to contrast against — show the union at full opacity.
    if (context == null) return ACTIVE_ALPHA
    // Legacy nodes with no recorded observations cannot be classified historical; keep them opaque.
    if (provenance.isEmpty()) return ACTIVE_ALPHA
    return if (provenance.any { isActiveRecord(it, context) }) ACTIVE_ALPHA else FADED_ALPHA
  }

  /** True when the node/edge is faded (reached only historically / by another build or device). */
  fun isFaded(provenance: List<ScreenProvenance>, context: NavigationActiveContext?): Boolean =
    alphaFor(provenance, context) == FADED_ALPHA

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
