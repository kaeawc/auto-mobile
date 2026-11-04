package dev.jasonpearson.automobile.desktop.core.navigation

import dev.jasonpearson.automobile.desktop.core.navigation.MultiBuildNavigationFixture.ACTIVE_DEVICE
import dev.jasonpearson.automobile.desktop.core.navigation.MultiBuildNavigationFixture.OTHER_DEVICE
import dev.jasonpearson.automobile.desktop.core.navigation.MultiBuildNavigationFixture.activeContext
import dev.jasonpearson.automobile.desktop.core.navigation.MultiBuildNavigationFixture.v1
import dev.jasonpearson.automobile.desktop.core.navigation.MultiBuildNavigationFixture.v2
import dev.jasonpearson.automobile.desktop.core.navigation.ProvenanceRecency.FRESH_WINDOW_MS
import dev.jasonpearson.automobile.desktop.core.navigation.ProvenanceRecency.NEWEST_FADED_ALPHA
import dev.jasonpearson.automobile.desktop.core.navigation.ProvenanceRecency.OLDEST_FADED_ALPHA
import dev.jasonpearson.automobile.desktop.core.navigation.ProvenanceRecency.STALE_AFTER_MS
import dev.jasonpearson.automobile.desktop.core.time.FakeClock
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.junit.Test

/** Recency-graded fade for historical nodes and edges (#16952), driven by a fake clock. */
class ProvenanceRecencyTest {

  private val day = FRESH_WINDOW_MS
  private val clock = FakeClock(initialMs = 1_000L * day)

  private fun seen(build: ProvenanceBuildKey, deviceId: String, ageMs: Long) =
    ScreenProvenance(build, deviceId, "s", lastSeen = clock.nowMs() - ageMs)

  @Test
  fun `faded alpha is bounded and monotonic in age`() {
    val now = clock.nowMs()
    val ages = listOf(0L, day, 2 * day, 7 * day, 30 * day, 89 * day, 90 * day, 400 * day)
    val alphas = ages.map { ProvenanceRecency.fadedAlpha(now - it, now) }
    assertEquals(NEWEST_FADED_ALPHA, alphas.first())
    assertEquals(NEWEST_FADED_ALPHA, alphas[1])
    assertEquals(OLDEST_FADED_ALPHA, alphas[ages.indexOf(STALE_AFTER_MS)])
    assertEquals(OLDEST_FADED_ALPHA, alphas.last())
    assertTrue(alphas.all { it in OLDEST_FADED_ALPHA..NEWEST_FADED_ALPHA })
    assertTrue(alphas.zipWithNext().all { (newer, older) -> older <= newer })
    // A week and a month are distinct steps between the bounds, not flattened to an end.
    val week = alphas[ages.indexOf(7 * day)]
    val month = alphas[ages.indexOf(30 * day)]
    assertTrue(week < NEWEST_FADED_ALPHA && month < week && month > OLDEST_FADED_ALPHA)
  }

  @Test
  fun `future and missing last-seen clamp to the bounds`() {
    val now = clock.nowMs()
    assertEquals(NEWEST_FADED_ALPHA, ProvenanceRecency.fadedAlpha(now + day, now))
    assertEquals(OLDEST_FADED_ALPHA, ProvenanceRecency.fadedAlpha(null, now))
    assertEquals(OLDEST_FADED_ALPHA, ProvenanceRecency.fadedAlpha(0L, now))
  }

  @Test
  fun `newest record decides the fade`() {
    val records = listOf(seen(v1, OTHER_DEVICE, 200 * day), seen(v1, OTHER_DEVICE, day / 2))
    assertEquals(NEWEST_FADED_ALPHA, ProvenanceRecency.fadedAlphaFor(records, clock.nowMs()))
  }

  @Test
  fun `union lens grades historical records and keeps active ones opaque`() {
    val recent = listOf(seen(v1, OTHER_DEVICE, day / 2))
    val old = listOf(seen(v1, OTHER_DEVICE, 120 * day))
    val alpha = { p: List<ScreenProvenance> ->
      NavigationBuildLens.alphaFor(p, activeContext, BuildLens.Union, clock.nowMs())
    }
    assertEquals(NEWEST_FADED_ALPHA, alpha(recent))
    assertEquals(OLDEST_FADED_ALPHA, alpha(old))
    assertEquals(ProvenanceOpacity.ACTIVE_ALPHA, alpha(old + seen(v2, ACTIVE_DEVICE, 300 * day)))
    // Offline: the union stays at full opacity however old the records are.
    assertEquals(
      ProvenanceOpacity.ACTIVE_ALPHA,
      NavigationBuildLens.alphaFor(old, null, BuildLens.Union, clock.nowMs()),
    )
  }

  @Test
  fun `filter lens grades other-build records and ignores legacy ones`() {
    val lens = BuildLens.Filter(v1)
    val legacy =
      ScreenProvenance(v1.copy(versionCode = 0), ProvenanceOpacity.LEGACY_DEVICE_SENTINEL, "l", 1)
    val oldOtherBuild = listOf(seen(v2, ACTIVE_DEVICE, 120 * day))
    assertEquals(
      OLDEST_FADED_ALPHA,
      NavigationBuildLens.alphaFor(oldOtherBuild, activeContext, lens, clock.nowMs()),
    )
    // Advancing the clock never brightens a fade; legacy records do not count toward recency.
    clock.advanceBy(7 * day)
    assertEquals(
      OLDEST_FADED_ALPHA,
      NavigationBuildLens.alphaFor(oldOtherBuild + legacy, activeContext, lens, clock.nowMs()),
    )
    val recentOtherBuild = listOf(seen(v2, ACTIVE_DEVICE, 0L))
    assertEquals(
      NEWEST_FADED_ALPHA,
      NavigationBuildLens.alphaFor(recentOtherBuild, activeContext, lens, clock.nowMs()),
    )
    assertEquals(
      ProvenanceOpacity.ACTIVE_ALPHA,
      NavigationBuildLens.alphaFor(
        recentOtherBuild + seen(v1, OTHER_DEVICE, 300 * day),
        activeContext,
        lens,
        clock.nowMs(),
      ),
    )
  }

  @Test
  fun `content descriptions keep carrying last seen`() {
    val records = listOf(seen(v1, OTHER_DEVICE, 120 * day))
    val lastSeen = records.single().lastSeen
    assertTrue(
      ProvenanceOpacity.contentDescription("Login", records, activeContext)
        .endsWith("last seen $lastSeen"),
    )
    assertEquals(
      "Login — not in build v2 (hashB), last seen $lastSeen",
      NavigationBuildLens.contentDescription("Login", records, activeContext, BuildLens.Filter(v2)),
    )
  }
}
