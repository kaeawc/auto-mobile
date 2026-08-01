package dev.jasonpearson.automobile.desktop.core.datasource

typealias NavigationGraph = dev.jasonpearson.automobile.desktop.domain.NavigationGraph

/**
 * Summary of one app that has a persisted navigation graph, as surfaced by the device-optional
 * `automobile:navigation/apps` daemon resource. Used by the offline-browse surface (Phase C
 * of #4837) to let the user pick an app to inspect from persisted data with no live device.
 *
 * @param appId The app's package/bundle id (stable key used to pull its graph).
 * @param displayName Human-friendly label if the daemon knows one; null when unknown (fall back to
 *   [appId] in the UI).
 * @param lastUpdated ISO-8601 timestamp of the most recent recorded navigation for this app. The
 *   daemon orders the list newest-first; kept as the raw string (no parsing) since it is
 *   display-only here.
 */
data class NavigationAppSummary(
  val appId: String,
  val displayName: String?,
  val lastUpdated: String,
)

interface NavigationDataSource {
  suspend fun getNavigationGraph(): Result<NavigationGraph>

  /**
   * Lists apps that have a persisted navigation graph, newest-first. Device-independent: the
   * `automobile:navigation/apps` resource does not require an observed device, so this backs
   * offline browsing.
   *
   * Defaulted so the many app-scoped [NavigationDataSource] implementations that only ever serve a
   * single app's graph (e.g. the per-app sources created by
   * [dev.jasonpearson.automobile.desktop.core.workspace.NavigationFacet]) need not implement it.
   * The meaningful implementations are [RealNavigationDataSource], [FakeNavigationDataSource], and
   * [CachedNavigationDataSource]; the offline browser is the only consumer.
   */
  suspend fun listApps(): Result<List<NavigationAppSummary>> = Result.Success(emptyList())
}
