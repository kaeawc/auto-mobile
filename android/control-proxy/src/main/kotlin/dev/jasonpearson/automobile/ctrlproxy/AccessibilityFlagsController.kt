package dev.jasonpearson.automobile.ctrlproxy

import android.accessibilityservice.AccessibilityServiceInfo
import android.util.Log

/**
 * Applies the client's `set_accessibility_flags` request: the three service-info flags that shape
 * the hierarchy, and occlusion filtering, which is local state rather than a service flag.
 */
internal class AccessibilityFlagsController(private val host: Host) {
  /** The bound service's configuration. */
  interface Host {
    /**
     * Runs [compute] on the bound service's current flags and reconfigures the service with a
     * non-null result, reading the configuration once. False when the service is not bound yet.
     */
    fun updateServiceFlags(compute: (currentFlags: Int) -> Int?): Boolean
  }

  enum class Outcome {
    /** No service configuration yet; only occlusion took effect. */
    UNBOUND,
    /** The service already had these flags, so it was not reconfigured. */
    UNCHANGED,
    APPLIED,
  }

  /** Read by hierarchy extraction; defaults on until the client says otherwise. */
  @Volatile
  var occlusionEnabled: Boolean = true
    private set

  fun apply(
    includeNotImportantViews: Boolean,
    reportViewIds: Boolean,
    retrieveInteractiveWindows: Boolean,
    occlusionEnabled: Boolean,
  ): Outcome {
    // Not a service flag, so it takes effect even before the service configuration exists.
    this.occlusionEnabled = occlusionEnabled

    var changed = false
    val bound = host.updateServiceFlags { currentFlags ->
      val flags =
        computeServiceFlags(
          currentFlags = currentFlags,
          includeNotImportantViews = includeNotImportantViews,
          reportViewIds = reportViewIds,
          retrieveInteractiveWindows = retrieveInteractiveWindows,
        )
      // Reassigning serviceInfo reconfigures the LIVE service, not a local no-op. The client
      // re-sends these flags on every ensureConnected(), and reconfiguring each time was seen to
      // disrupt in-flight hierarchy capture (elements=0 on every observe for an entire run).
      changed = flags != currentFlags
      flags.takeIf { changed }
    }

    val outcome =
      when {
        !bound -> Outcome.UNBOUND
        changed -> Outcome.APPLIED
        else -> Outcome.UNCHANGED
      }
    when (outcome) {
      Outcome.UNBOUND -> Log.w(TAG, "Cannot apply accessibility flags — serviceInfo is null")
      Outcome.UNCHANGED ->
        Log.d(TAG, "Accessibility flags unchanged - skipping serviceInfo reassignment")
      Outcome.APPLIED ->
        Log.i(
          TAG,
          "Applied accessibility flags: " +
            "includeNotImportantViews=$includeNotImportantViews, " +
            "reportViewIds=$reportViewIds, " +
            "retrieveInteractiveWindows=$retrieveInteractiveWindows, " +
            "occlusionEnabled=$occlusionEnabled",
        )
    }
    return outcome
  }

  companion object {
    private const val TAG = "CtrlProxy"

    /** Sets or clears each requested flag on [currentFlags], leaving every other bit alone. */
    internal fun computeServiceFlags(
      currentFlags: Int,
      includeNotImportantViews: Boolean,
      reportViewIds: Boolean,
      retrieveInteractiveWindows: Boolean,
    ): Int =
      currentFlags
        .withFlag(
          AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS,
          includeNotImportantViews,
        )
        .withFlag(AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS, reportViewIds)
        .withFlag(
          AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS,
          retrieveInteractiveWindows,
        )

    private fun Int.withFlag(flag: Int, enabled: Boolean): Int =
      if (enabled) this or flag else this and flag.inv()
  }
}
