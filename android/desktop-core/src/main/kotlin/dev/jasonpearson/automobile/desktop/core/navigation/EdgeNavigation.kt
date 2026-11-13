package dev.jasonpearson.automobile.desktop.core.navigation

import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.daemon.DaemonJson
import dev.jasonpearson.automobile.desktop.core.daemon.McpConnectionException
import java.io.IOException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put
import org.slf4j.LoggerFactory

private val LOG = LoggerFactory.getLogger("EdgeNavigation")

/**
 * Whether a pane can navigate its device along a transition (#16953).
 * - [Navigate]: a verified path for the active build.
 * - [Speculative]: reached only by another build. It can be attempted, but the path may not exist
 *   in this build, and the UI says so before and after the attempt.
 * - [Disabled]: offline / read-only browse, where there is no device to drive.
 */
enum class EdgeNavigateAvailability {
  Navigate,
  Speculative,
  Disabled,
}

/** The device's answer to one navigate attempt. */
data class EdgeNavigationResult(
  val success: Boolean,
  val currentScreen: String?,
  val message: String? = null,
)

/**
 * Drives a pane's device along one transition: to its source, then that transition only (#16982).
 * Live panes back it with the daemon's `navigateTo` tool.
 */
fun interface EdgeNavigator {
  suspend fun navigateTo(deviceId: String, transition: ScreenTransition): EdgeNavigationResult
}

/** What one attempt along a transition came to, as shown after it runs. */
sealed interface EdgeNavigationOutcome {
  val transition: ScreenTransition
  val speculative: Boolean

  data class Running(override val transition: ScreenTransition, override val speculative: Boolean) :
    EdgeNavigationOutcome

  data class Reached(override val transition: ScreenTransition, override val speculative: Boolean) :
    EdgeNavigationOutcome

  data class NotReached(
    override val transition: ScreenTransition,
    override val speculative: Boolean,
    val currentScreen: String?,
    val message: String?,
  ) : EdgeNavigationOutcome
}

object EdgeNavigation {
  const val SPECULATIVE_LABEL: String = "Speculative"
  const val SPECULATIVE_WARNING: String =
    "This path was only seen on another build and may not exist in the active build."

  /** Navigate availability, decided only by the edge's [verification] and the pane's [readOnly]. */
  fun availability(verification: EdgeVerification, readOnly: Boolean): EdgeNavigateAvailability =
    when {
      readOnly -> EdgeNavigateAvailability.Disabled
      verification == EdgeVerification.BrowseOnly -> EdgeNavigateAvailability.Disabled
      verification == EdgeVerification.UnverifiedForActiveBuild ->
        EdgeNavigateAvailability.Speculative
      else -> EdgeNavigateAvailability.Navigate
    }

  /** Visible label of the navigate action. */
  fun actionLabel(availability: EdgeNavigateAvailability): String =
    when (availability) {
      EdgeNavigateAvailability.Navigate -> "Navigate device along this transition"
      EdgeNavigateAvailability.Speculative -> "Try speculative navigation"
      EdgeNavigateAvailability.Disabled -> "Navigate actions disabled (offline)"
    }

  /** Accessible description of the navigate action, before it runs. */
  fun actionDescription(transition: ScreenTransition, availability: EdgeNavigateAvailability) =
    "${actionLabel(availability)}: ${edgeName(transition)}" +
      if (availability == EdgeNavigateAvailability.Speculative) " — $SPECULATIVE_WARNING" else ""

  /** Run one attempt along [transition] on [deviceId] and classify it. */
  suspend fun attempt(
    navigator: EdgeNavigator,
    deviceId: String,
    transition: ScreenTransition,
    availability: EdgeNavigateAvailability,
  ): EdgeNavigationOutcome {
    require(availability != EdgeNavigateAvailability.Disabled) { "navigate is disabled" }
    val speculative = availability == EdgeNavigateAvailability.Speculative
    val result = navigator.navigateTo(deviceId, transition)
    return if (result.success && result.currentScreen == transition.toScreen) {
      EdgeNavigationOutcome.Reached(transition, speculative)
    } else {
      EdgeNavigationOutcome.NotReached(
        transition,
        speculative,
        result.currentScreen,
        result.message,
      )
    }
  }

  /**
   * Visible and accessible text for an [outcome]. [verificationNow] is the edge's verification
   * against the latest graph: a speculative attempt that reached its target makes the edge verified
   * once the daemon records the traversal under the active build.
   */
  fun outcomeText(outcome: EdgeNavigationOutcome, verificationNow: EdgeVerification): String {
    val prefix = if (outcome.speculative) "$SPECULATIVE_LABEL attempt" else "Navigation"
    val target = outcome.transition.toScreen
    return when (outcome) {
      is EdgeNavigationOutcome.Running -> "$prefix to $target running…"
      is EdgeNavigationOutcome.Reached ->
        when {
          !outcome.speculative -> "$prefix reached $target"
          verificationNow == EdgeVerification.Verified ->
            "$prefix reached $target — now verified for the active build"
          else -> "$prefix reached $target — waiting for the active build to record it"
        }
      is EdgeNavigationOutcome.NotReached -> {
        val where = outcome.currentScreen?.let { " (stopped on $it)" } ?: ""
        val why = outcome.message?.takeIf { it.isNotBlank() }?.let { ": $it" } ?: ""
        val hint = if (outcome.speculative) "; the path may not exist in this build" else ""
        "$prefix did not reach $target$where$hint$why"
      }
    }
  }

  private fun edgeName(transition: ScreenTransition) =
    "${transition.fromScreen} → ${transition.toScreen}"
}

/**
 * [EdgeNavigator] over the daemon's `navigateTo` tool. [clientProvider] must allocate the device to
 * the desktop session (an input client), since navigating drives the device.
 */
class DaemonEdgeNavigator(
  private val clientProvider: () -> AutoMobileClient?,
  private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
) : EdgeNavigator {
  override suspend fun navigateTo(
    deviceId: String,
    transition: ScreenTransition,
  ): EdgeNavigationResult =
    withContext(ioDispatcher) {
      val targetScreen = transition.toScreen
      val client =
        clientProvider()
          ?: return@withContext EdgeNavigationResult(false, null, "No daemon connection")
      try {
        client.setToolEnabled("navigateTo")
        val response =
          client.callTool(
            "navigateTo",
            buildJsonObject {
              put("targetScreen", targetScreen)
              put("deviceId", deviceId)
              put("viaTransition", viaTransitionArgs(transition))
            },
          )
        parseNavigateToResponse(response)
      } catch (error: McpConnectionException) {
        // A refused or failed attempt (tool errors included) is reported in the pane as "did not
        // reach", not thrown.
        failed(deviceId, targetScreen, error)
      } catch (error: IOException) {
        failed(deviceId, targetScreen, error)
      }
    }

  private fun failed(
    deviceId: String,
    targetScreen: String,
    error: Exception,
  ): EdgeNavigationResult {
    LOG.warn("navigateTo $targetScreen on $deviceId failed", error)
    return EdgeNavigationResult(false, null, error.message ?: error::class.simpleName)
  }
}

/**
 * `navigateTo`'s `viaTransition` for [transition]: its screens, plus its graph edge id when the id
 * is one (`getNavigationGraph` edge ids are numeric), so parallel edges between the same screens
 * stay distinct.
 */
internal fun viaTransitionArgs(transition: ScreenTransition): JsonObject = buildJsonObject {
  put("from", transition.fromScreen)
  put("to", transition.toScreen)
  transition.id.toLongOrNull()?.let { put("edgeId", it) }
}

/**
 * Reads `navigateTo`'s `{success, currentScreen, error|message}` payload. The daemon reports an
 * unreached target as a tool error with the same payload, so the envelope's `isError` is not used.
 */
internal fun parseNavigateToResponse(response: JsonElement): EdgeNavigationResult {
  val text =
    ((response as? JsonObject)?.get("content") as? JsonArray)
      ?.mapNotNull { it as? JsonObject }
      ?.firstOrNull { (it["type"] as? JsonPrimitive)?.contentOrNull == "text" }
      ?.let { (it["text"] as? JsonPrimitive)?.contentOrNull }
      ?: return EdgeNavigationResult(false, null, "navigateTo returned no result")
  val payload =
    try {
      DaemonJson.decodeFromString<JsonElement>(text) as? JsonObject
    } catch (error: SerializationException) {
      LOG.warn("navigateTo returned non-JSON text", error)
      null
    } ?: return EdgeNavigationResult(false, null, text)
  val success = (payload["success"] as? JsonPrimitive)?.booleanOrNull == true
  val currentScreen = (payload["currentScreen"] as? JsonPrimitive)?.contentOrNull
  val message =
    listOf("error", "message").firstNotNullOfOrNull { key ->
      (payload[key] as? JsonPrimitive)?.contentOrNull
        ?: ((payload[key] as? JsonObject)?.get("message") as? JsonPrimitive)?.contentOrNull
    }
  return EdgeNavigationResult(success, currentScreen, message)
}
