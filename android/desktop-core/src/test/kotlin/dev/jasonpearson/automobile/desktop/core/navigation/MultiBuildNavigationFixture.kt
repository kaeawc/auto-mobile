package dev.jasonpearson.automobile.desktop.core.navigation

import dev.jasonpearson.automobile.desktop.core.datasource.NavigationDataSource
import dev.jasonpearson.automobile.desktop.core.datasource.Result
import dev.jasonpearson.automobile.desktop.domain.NavigationGraph

/**
 * An app-union graph observed across two builds (#4987):
 * - Home, and Login → Home, were reached by both builds.
 * - Login, and Home → Login, only by v1 (hashA) on another device.
 * - Search, and Home → Search, only by v2 (hashB) on the active device.
 * - Legacy has no recorded provenance (unclassified).
 */
internal object MultiBuildNavigationFixture {
  const val PACKAGE = "com.example.app"
  const val ACTIVE_DEVICE = "emulator-5554"
  const val OTHER_DEVICE = "emulator-9999"

  val v1 = ProvenanceBuildKey(PACKAGE, versionCode = 1, contentHash = "hashA")
  val v2 = ProvenanceBuildKey(PACKAGE, versionCode = 2, contentHash = "hashB")

  /** The pane is on the active device running v2. */
  val activeContext =
    NavigationActiveContext(deviceId = ACTIVE_DEVICE, packageId = PACKAGE, buildKey = v2)

  fun seen(build: ProvenanceBuildKey, deviceId: String) =
    ScreenProvenance(buildKey = build, deviceId = deviceId, sessionUuid = "s", lastSeen = 1L)

  private val onV1 = seen(v1, OTHER_DEVICE)
  private val onV2 = seen(v2, ACTIVE_DEVICE)

  private fun node(name: String, provenance: List<ScreenProvenance>) =
    ScreenNode(name.lowercase(), name, "Activity", PACKAGE, 0, 0L, provenance = provenance)

  private fun edge(id: String, from: String, to: String, provenance: List<ScreenProvenance>) =
    ScreenTransition(id, from, to, "tap", null, 0, 0f, provenance = provenance)

  val graph =
    NavigationGraph(
      screens =
        listOf(
          node("Home", listOf(onV1, onV2)),
          node("Login", listOf(onV1)),
          node("Search", listOf(onV2)),
          node("Legacy", emptyList()),
        ),
      transitions =
        listOf(
          edge("toLogin", "Home", "Login", listOf(onV1)),
          edge("toSearch", "Home", "Search", listOf(onV2)),
          edge("toHome", "Login", "Home", listOf(onV1, onV2)),
        ),
    )
}

/** Fake [NavigationDataSource] serving [MultiBuildNavigationFixture.graph]. */
internal class FakeMultiBuildNavigationDataSource(
  private val graph: NavigationGraph = MultiBuildNavigationFixture.graph,
) : NavigationDataSource {
  override suspend fun getNavigationGraph(): Result<NavigationGraph> = Result.Success(graph)
}
