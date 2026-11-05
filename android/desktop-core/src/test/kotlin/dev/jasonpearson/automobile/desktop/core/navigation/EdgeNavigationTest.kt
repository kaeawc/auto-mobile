package dev.jasonpearson.automobile.desktop.core.navigation

import dev.jasonpearson.automobile.desktop.core.datasource.Result
import dev.jasonpearson.automobile.desktop.core.navigation.MultiBuildNavigationFixture.ACTIVE_DEVICE
import dev.jasonpearson.automobile.desktop.core.navigation.MultiBuildNavigationFixture.activeContext
import dev.jasonpearson.automobile.desktop.core.navigation.MultiBuildNavigationFixture.seen
import dev.jasonpearson.automobile.desktop.core.navigation.MultiBuildNavigationFixture.v2
import dev.jasonpearson.automobile.desktop.domain.NavigationGraph
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Test

/** Navigate availability and speculative attempts along nav edges (#16953). */
class EdgeNavigationTest {

  /** Fake device: lands on [landsOn] for any target, recording each request. */
  private class FakeEdgeNavigator(private val landsOn: (String) -> String?) : EdgeNavigator {
    val requests = mutableListOf<Pair<String, String>>()

    override suspend fun navigateTo(deviceId: String, targetScreen: String): EdgeNavigationResult {
      requests += deviceId to targetScreen
      val current = landsOn(targetScreen)
      return EdgeNavigationResult(current == targetScreen, current, null)
    }
  }

  private suspend fun loadGraph(): NavigationGraph =
    (FakeMultiBuildNavigationDataSource().getNavigationGraph() as Result.Success).data

  @Test
  fun `availability is a pure function of verification and read-only`() {
    val expected =
      mapOf(
        (EdgeVerification.Verified to false) to EdgeNavigateAvailability.Navigate,
        (EdgeVerification.UnverifiedForActiveBuild to false) to
          EdgeNavigateAvailability.Speculative,
        (EdgeVerification.BrowseOnly to false) to EdgeNavigateAvailability.Disabled,
        (EdgeVerification.Verified to true) to EdgeNavigateAvailability.Disabled,
        (EdgeVerification.UnverifiedForActiveBuild to true) to EdgeNavigateAvailability.Disabled,
        (EdgeVerification.BrowseOnly to true) to EdgeNavigateAvailability.Disabled,
      )
    expected.forEach { (input, availability) ->
      assertEquals(availability, EdgeNavigation.availability(input.first, input.second), "$input")
    }
  }

  @Test
  fun `speculative action is labelled before it runs`() = runTest {
    val toLogin = loadGraph().transitions.single { it.id == "toLogin" }
    val availability =
      EdgeNavigation.availability(NavigationBuildLens.verification(toLogin, activeContext), false)
    assertEquals(EdgeNavigateAvailability.Speculative, availability)
    assertEquals("Try speculative navigation", EdgeNavigation.actionLabel(availability))
    assertEquals(
      "Try speculative navigation: Home → Login — ${EdgeNavigation.SPECULATIVE_WARNING}",
      EdgeNavigation.actionDescription(toLogin, availability),
    )
  }

  @Test
  fun `speculative attempt that reaches the target becomes verified once recorded`() = runTest {
    val graph = loadGraph()
    val toLogin = graph.transitions.single { it.id == "toLogin" }
    val navigator = FakeEdgeNavigator { it }
    val outcome =
      EdgeNavigation.attempt(
        navigator,
        ACTIVE_DEVICE,
        toLogin,
        EdgeNavigateAvailability.Speculative,
      )
    assertEquals(listOf(ACTIVE_DEVICE to "Login"), navigator.requests)
    assertEquals(EdgeNavigationOutcome.Reached(toLogin, speculative = true), outcome)
    assertEquals(
      "Speculative attempt reached Login — waiting for the active build to record it",
      EdgeNavigation.outcomeText(outcome, NavigationBuildLens.verification(toLogin, activeContext)),
    )
    // The daemon records the traversal under the active build; the refreshed edge is verified.
    val recorded = toLogin.copy(provenance = toLogin.provenance + seen(v2, ACTIVE_DEVICE))
    val now = NavigationBuildLens.verification(recorded, activeContext)
    assertEquals(EdgeVerification.Verified, now)
    assertEquals(
      "Speculative attempt reached Login — now verified for the active build",
      EdgeNavigation.outcomeText(outcome, now),
    )
  }

  @Test
  fun `speculative attempt that misses reports where it stopped`() = runTest {
    val toLogin = loadGraph().transitions.single { it.id == "toLogin" }
    val outcome =
      EdgeNavigation.attempt(
        FakeEdgeNavigator { "Home" },
        ACTIVE_DEVICE,
        toLogin,
        EdgeNavigateAvailability.Speculative,
      )
    assertEquals(
      "Speculative attempt did not reach Login (stopped on Home); the path may not exist in " +
        "this build",
      EdgeNavigation.outcomeText(outcome, EdgeVerification.UnverifiedForActiveBuild),
    )
  }

  @Test
  fun `verified attempt is not labelled speculative`() = runTest {
    val toSearch = loadGraph().transitions.single { it.id == "toSearch" }
    val outcome =
      EdgeNavigation.attempt(
        FakeEdgeNavigator { it },
        ACTIVE_DEVICE,
        toSearch,
        EdgeNavigateAvailability.Navigate,
      )
    val text = EdgeNavigation.outcomeText(outcome, EdgeVerification.Verified)
    assertEquals("Navigation reached Search", text)
    assertTrue(EdgeNavigation.SPECULATIVE_LABEL !in text)
  }

  @Test
  fun `navigateTo payload is read from success and error results alike`() {
    fun envelope(text: String, isError: Boolean) =
      JsonObject(
        mapOf(
          "content" to
            JsonArray(
              listOf(
                JsonObject(mapOf("type" to JsonPrimitive("text"), "text" to JsonPrimitive(text))),
              ),
            ),
          "isError" to JsonPrimitive(isError),
        ),
      )
    assertEquals(
      EdgeNavigationResult(true, "Login", null),
      parseNavigateToResponse(
        envelope("""{"success":true,"currentScreen":"Login","targetScreen":"Login"}""", false),
      ),
    )
    assertEquals(
      EdgeNavigationResult(false, "Home", "No path found"),
      parseNavigateToResponse(
        envelope("""{"success":false,"currentScreen":"Home","error":"No path found"}""", true),
      ),
    )
    assertEquals(
      EdgeNavigationResult(false, null, "device busy"),
      parseNavigateToResponse(envelope("device busy", true)),
    )
  }
}
