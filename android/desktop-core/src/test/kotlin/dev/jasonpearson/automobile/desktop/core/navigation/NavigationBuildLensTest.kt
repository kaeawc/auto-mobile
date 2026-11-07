package dev.jasonpearson.automobile.desktop.core.navigation

import dev.jasonpearson.automobile.desktop.core.datasource.Result
import dev.jasonpearson.automobile.desktop.core.navigation.MultiBuildNavigationFixture.ACTIVE_DEVICE
import dev.jasonpearson.automobile.desktop.core.navigation.MultiBuildNavigationFixture.OTHER_DEVICE
import dev.jasonpearson.automobile.desktop.core.navigation.MultiBuildNavigationFixture.activeContext
import dev.jasonpearson.automobile.desktop.core.navigation.MultiBuildNavigationFixture.seen
import dev.jasonpearson.automobile.desktop.core.navigation.MultiBuildNavigationFixture.v1
import dev.jasonpearson.automobile.desktop.core.navigation.MultiBuildNavigationFixture.v2
import dev.jasonpearson.automobile.desktop.domain.NavigationGraph
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest
import org.junit.Test

/** Build filter, two-build diff and unverified-edge marking over the app-union graph (#4987). */
private const val NOW = 1_000L

class NavigationBuildLensTest {

  private suspend fun loadGraph(): NavigationGraph =
    (FakeMultiBuildNavigationDataSource().getNavigationGraph() as Result.Success).data

  private fun NavigationGraph.transition(id: String) = transitions.single { it.id == id }

  @Test
  fun `builds are listed newest first and exclude legacy records`() = runTest {
    val legacy =
      ScreenProvenance(
        ProvenanceBuildKey(MultiBuildNavigationFixture.PACKAGE, 0, ""),
        ProvenanceOpacity.LEGACY_DEVICE_SENTINEL,
        "legacy",
        0L,
      )
    val graph = loadGraph()
    val withLegacy =
      graph.copy(screens = graph.screens + graph.screens.first().copy(provenance = listOf(legacy)))
    assertEquals(listOf(v2, v1), NavigationBuildLens.buildsIn(withLegacy))
  }

  @Test
  fun `fade filter emphasizes the selected build and fades the others`() = runTest {
    val graph = loadGraph()
    val lens = BuildLens.Filter(v1)
    val alphas =
      graph.screens.associate {
        it.name to NavigationBuildLens.alphaFor(it.provenance, activeContext, lens, NOW)
      }
    assertEquals(
      mapOf(
        "Home" to ProvenanceOpacity.ACTIVE_ALPHA,
        "Login" to ProvenanceOpacity.ACTIVE_ALPHA,
        "Search" to ProvenanceOpacity.FADED_ALPHA,
        "Legacy" to ProvenanceOpacity.ACTIVE_ALPHA,
      ),
      alphas,
    )
    // A fade filter is a lens on the single union: nothing is removed.
    assertEquals(graph, NavigationBuildLens.visibleGraph(graph, lens))
    assertEquals(
      "Search — not in build v1 (hashA), last seen 1",
      NavigationBuildLens.contentDescription(
        "Search",
        graph.screens[2].provenance,
        activeContext,
        lens,
      ),
    )
    assertEquals(
      "Legacy — no build recorded",
      NavigationBuildLens.contentDescription("Legacy", emptyList(), activeContext, lens),
    )
  }

  @Test
  fun `hide filter keeps only the selected build's reachable set`() = runTest {
    val visible =
      NavigationBuildLens.visibleGraph(loadGraph(), BuildLens.Filter(v1, hideOtherBuilds = true))
    assertEquals(listOf("Home", "Login", "Legacy"), visible.screens.map { it.name })
    assertEquals(listOf("toLogin", "toHome"), visible.transitions.map { it.id })
  }

  @Test
  fun `hide filter drops an in-build edge whose endpoint is hidden`() = runTest {
    val graph = loadGraph()
    val dangling =
      graph.copy(
        transitions =
          graph.transitions +
            ScreenTransition(
              "toSearchV1",
              "Login",
              "Search",
              "tap",
              null,
              0,
              0f,
              provenance = listOf(seen(v1, OTHER_DEVICE)),
            ),
      )
    val visible =
      NavigationBuildLens.visibleGraph(dangling, BuildLens.Filter(v1, hideOtherBuilds = true))
    assertFalse(visible.transitions.any { it.id == "toSearchV1" })
  }

  @Test
  fun `union lens defers to phase 2 provenance opacity`() = runTest {
    val graph = loadGraph()
    val login = graph.screens.single { it.name == "Login" }
    assertEquals(
      ProvenanceOpacity.alphaFor(login.provenance, activeContext, NOW),
      NavigationBuildLens.alphaFor(login.provenance, activeContext, BuildLens.Union, NOW),
    )
    assertEquals(graph, NavigationBuildLens.visibleGraph(graph, BuildLens.Union))
  }

  @Test
  fun `two-build diff classifies nodes and edges present in one build but not the other`() =
    runTest {
      val diff = NavigationBuildLens.diff(loadGraph(), v1, v2)
      assertEquals(listOf("Login"), diff.screensWith(BuildDiffStatus.OnlyInA).map { it.name })
      assertEquals(listOf("Search"), diff.screensWith(BuildDiffStatus.OnlyInB).map { it.name })
      assertEquals(listOf("Home"), diff.screensWith(BuildDiffStatus.InBoth).map { it.name })
      assertEquals(listOf("toLogin"), diff.transitionsWith(BuildDiffStatus.OnlyInA).map { it.id })
      assertEquals(listOf("toSearch"), diff.transitionsWith(BuildDiffStatus.OnlyInB).map { it.id })
      assertEquals(listOf("toHome"), diff.transitionsWith(BuildDiffStatus.InBoth).map { it.id })
      // Unclassified nodes belong to neither build and are left out of the diff.
      assertFalse(diff.screens.any { it.item.name == "Legacy" })
      assertTrue(diff.hasDifferences)
      assertEquals(
        "Only in A: 1 screens, 1 transitions · Only in B: 1 screens, 1 transitions · " +
          "In both: 1 screens, 1 transitions",
        buildDiffSummary(diff),
      )
    }

  @Test
  fun `diffing a build against itself has no differences`() = runTest {
    val diff = NavigationBuildLens.diff(loadGraph(), v2, v2)
    assertFalse(diff.hasDifferences)
    assertEquals(
      "No differences: 2 screens and 2 transitions in both builds",
      buildDiffSummary(diff),
    )
  }

  @Test
  fun `edge reached only by another build is unverified for the active build`() = runTest {
    val graph = loadGraph()
    assertEquals(
      EdgeVerification.UnverifiedForActiveBuild,
      NavigationBuildLens.verification(graph.transition("toLogin"), activeContext),
    )
    assertEquals(
      EdgeVerification.Verified,
      NavigationBuildLens.verification(graph.transition("toSearch"), activeContext),
    )
    assertEquals(
      EdgeVerification.Verified,
      NavigationBuildLens.verification(graph.transition("toHome"), activeContext),
    )
  }

  @Test
  fun `active build reached on another device is still verified`() {
    val edge =
      ScreenTransition(
        "e",
        "A",
        "B",
        "tap",
        null,
        0,
        0f,
        provenance = listOf(seen(v2, OTHER_DEVICE)),
      )
    assertTrue(ProvenanceOpacity.isFaded(edge.provenance, activeContext))
    assertEquals(EdgeVerification.Verified, NavigationBuildLens.verification(edge, activeContext))
  }

  @Test
  fun `faded edge without an active build key stays unverified`() {
    val edge =
      ScreenTransition(
        "e",
        "A",
        "B",
        "tap",
        null,
        0,
        0f,
        provenance = listOf(seen(v2, OTHER_DEVICE)),
      )
    val noBuild = activeContext.copy(buildKey = null)
    assertEquals(
      EdgeVerification.UnverifiedForActiveBuild,
      NavigationBuildLens.verification(edge, noBuild),
    )
    val sameDevice = edge.copy(provenance = listOf(seen(v1, ACTIVE_DEVICE)))
    assertEquals(EdgeVerification.Verified, NavigationBuildLens.verification(sameDevice, noBuild))
  }

  @Test
  fun `offline has no active build so edges are browse-only`() = runTest {
    assertEquals(
      EdgeVerification.BrowseOnly,
      NavigationBuildLens.verification(loadGraph().transition("toLogin"), null),
    )
  }

  @Test
  fun `stale lens falls back to the union when its build disappears`() {
    assertEquals(BuildLens.Union, effectiveBuildLens(BuildLens.Filter(v1), listOf(v2)))
    assertEquals(BuildLens.Union, effectiveBuildLens(BuildLens.Compare(v1, v2), listOf(v2)))
    val compare = BuildLens.Compare(v1, v2)
    assertEquals(compare, effectiveBuildLens(compare, listOf(v1, v2)))
  }

  @Test
  fun `labels cut production-length hashes to a short prefix`() {
    val hash = "0123456789abcdef".repeat(4)
    assertEquals(
      "v7 (0123456789ab)",
      NavigationBuildLens.label(ProvenanceBuildKey(MultiBuildNavigationFixture.PACKAGE, 7, hash)),
    )
    assertEquals(
      "v0 (no hash)",
      NavigationBuildLens.label(ProvenanceBuildKey(MultiBuildNavigationFixture.PACKAGE, 0, "")),
    )
  }

  @Test
  fun `labels prefer the declared branch and short sha`() {
    val build = ProvenanceBuildKey(MultiBuildNavigationFixture.PACKAGE, 7, "hash")
    assertEquals(
      "feature/login@abcdef1",
      NavigationBuildLens.label(build, BuildSourceRevision("feature/login", "abcdef1234567")),
    )
    assertEquals("v7 (hash)", NavigationBuildLens.label(build, null))
  }

  @Test
  fun `graph labels use each build's declared revision and fall back for builds without one`() {
    val declared = ProvenanceBuildKey(MultiBuildNavigationFixture.PACKAGE, 2, "hashB")
    val plain = ProvenanceBuildKey(MultiBuildNavigationFixture.PACKAGE, 1, "hashA")
    val revision = BuildSourceRevision("main", "0123456789abcdef")
    fun record(build: ProvenanceBuildKey, rev: BuildSourceRevision?) =
      ScreenProvenance(build, "emu", "s1", 100L, rev)
    val graph =
      NavigationGraph(
        screens =
          listOf(
            ScreenNode(
              id = "1",
              name = "Home",
              type = "screen",
              packageName = MultiBuildNavigationFixture.PACKAGE,
              transitionCount = 0,
              discoveredAt = 0L,
              provenance = listOf(record(declared, revision), record(plain, null)),
            ),
          ),
        transitions = emptyList(),
      )

    assertEquals(
      mapOf(declared to "main@0123456", plain to "v1 (hashA)"),
      NavigationBuildLabels.labelsIn(graph),
    )
    // Identity is unchanged: the revision does not split or merge builds.
    assertEquals(listOf(declared, plain), NavigationBuildLens.buildsIn(graph))
  }
}
