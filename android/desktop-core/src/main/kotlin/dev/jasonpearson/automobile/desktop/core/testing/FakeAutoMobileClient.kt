package dev.jasonpearson.automobile.desktop.core.testing

import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileDeviceOperations
import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileFeatureOperations
import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileInputOperations
import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileStorageOperations
import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileTestOperations
import dev.jasonpearson.automobile.desktop.core.daemon.GestureInputStream
import dev.jasonpearson.automobile.desktop.core.daemon.InputActionResult
import dev.jasonpearson.automobile.desktop.core.daemon.McpResource
import dev.jasonpearson.automobile.desktop.core.daemon.McpResourceContent
import dev.jasonpearson.automobile.desktop.core.daemon.McpResourceTemplate
import dev.jasonpearson.automobile.desktop.core.daemon.McpTool
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/**
 * Reusable fake implementation of [AutoMobileClient] for testing.
 *
 * All methods record their call name in [calls] and return configurable values. Resource responses
 * can be set per-URI via [setResourceResponseWithText].
 */
class FakeAutoMobileClient private constructor(private val state: FakeAutoMobileClientState) :
  AutoMobileClient,
  AutoMobileDeviceOperations by FakeDeviceOperations(state),
  AutoMobileTestOperations by FakeTestOperations(state),
  AutoMobileInputOperations by FakeInputOperations(state),
  AutoMobileStorageOperations by FakeStorageOperations(state),
  AutoMobileFeatureOperations by FakeFeatureOperations(state) {
  constructor() : this(FakeAutoMobileClientState())

  /** Ordered list of method names that were called. */
  val calls by state::calls

  // -- Configurable return values --

  override var transportName by state::transportName
  override var connectionDescription by state::connectionDescription

  var pingResult by state::pingResult
  var listResourcesResult by state::listResourcesResult
  var listResourceTemplatesResult by state::listResourceTemplatesResult
  var listToolsResult by state::listToolsResult
  var getNavigationGraphResult by state::getNavigationGraphResult
  var listFeatureFlagsResult by state::listFeatureFlagsResult
  var setFeatureFlagResult by state::setFeatureFlagResult
  var listPerformanceAuditResultsResult by state::listPerformanceAuditResultsResult
  var getTestTimingsResult by state::getTestTimingsResult
  var getTestRunsResult by state::getTestRunsResult
  var startDeviceGestureRecordingResult by state::startDeviceGestureRecordingResult
  var stopDeviceGestureRecordingResult by state::stopDeviceGestureRecordingResult
  var executePlanResult by state::executePlanResult
  var startDeviceResult by state::startDeviceResult

  /** Results returned (in order) before falling back to [startDeviceResult]. */
  val queuedStartDeviceResults by state::queuedStartDeviceResults
  var setActiveDeviceResult by state::setActiveDeviceResult
  var observeResult by state::observeResult
  var observeError by state::observeError
  var killDeviceResult by state::killDeviceResult

  /** The `force` flag of every killDevice call, in order (auto-mobile #6864). */
  val killDeviceForceRequests by state::killDeviceForceRequests
  var getDaemonStatusResult by state::getDaemonStatusResult
  // When set, getDaemonStatus throws it instead of returning — models a wedged daemon whose
  // ide/status hang ceiling closed the socket, so the health probe reads UNHEALTHY (#6082).
  var getDaemonStatusError by state::getDaemonStatusError
  var updateServiceResult by state::updateServiceResult
  var inputTapResult by state::inputTapResult
  var inputSwipeResult by state::inputSwipeResult
  var inputPressButtonResult by state::inputPressButtonResult
  var inputTypeTextResult by state::inputTypeTextResult
  var inputKeyResult by state::inputKeyResult
  var setKeyValueResult by state::setKeyValueResult
  var removeKeyValueResult by state::removeKeyValueResult
  var clearKeyValueFileResult by state::clearKeyValueFileResult

  /** Runs inside each blocking key-value mutation, allowing tests to coordinate cancellation. */
  var onKeyValueMutation by state::onKeyValueMutation
  var callToolResult by state::callToolResult
  var throwOnReadResource by state::throwOnReadResource

  // -- Resource response mapping --

  private val resourceResponses = mutableMapOf<String, List<McpResourceContent>>()

  /** Set a text resource response for a given URI. */
  fun setResourceResponseWithText(uri: String, text: String) {
    resourceResponses[uri] =
      listOf(McpResourceContent(uri = uri, mimeType = "application/json", text = text))
  }

  /** Set raw resource content for a given URI. */
  fun setResourceResponse(uri: String, contents: List<McpResourceContent>) {
    resourceResponses[uri] = contents
  }

  // -- Recorded write calls --

  data class SetKeyValueCall(
    val deviceId: String,
    val appId: String,
    val fileName: String,
    val key: String,
    val value: String?,
    val type: String,
    val platform: String = "android",
    val sessionUuid: String? = null,
  )

  data class RemoveKeyValueCall(
    val deviceId: String,
    val appId: String,
    val fileName: String,
    val key: String,
    val platform: String = "android",
    val sessionUuid: String? = null,
  )

  data class ClearKeyValueFileCall(
    val deviceId: String,
    val appId: String,
    val fileName: String,
    val platform: String = "android",
    val sessionUuid: String? = null,
  )

  data class InputTapCall(
    val x: Double,
    val y: Double,
    val platform: String,
    val deviceId: String?,
    val duration: Int?,
    val frameContext: String? = null,
  )

  data class InputSwipeCall(
    val startX: Double,
    val startY: Double,
    val endX: Double,
    val endY: Double,
    val platform: String,
    val deviceId: String?,
    val durationMs: Int?,
    val frameContext: String? = null,
  )

  data class InputPressButtonCall(
    val button: String,
    val platform: String,
    val deviceId: String?,
    val frameContext: String? = null,
  )

  data class InputTypeTextCall(
    val text: String,
    val platform: String,
    val deviceId: String?,
    val submit: Boolean?,
    val append: Boolean = false,
    val frameContext: String? = null,
  )

  data class InputKeyCall(
    val key: String,
    val platform: String,
    val deviceId: String?,
    val frameContext: String? = null,
  )

  val setKeyValueCalls by state::setKeyValueCalls
  val removeKeyValueCalls by state::removeKeyValueCalls
  val clearKeyValueFileCalls by state::clearKeyValueFileCalls
  val inputTapCalls by state::inputTapCalls
  val inputSwipeCalls by state::inputSwipeCalls
  val inputPressButtonCalls by state::inputPressButtonCalls
  val inputTypeTextCalls by state::inputTypeTextCalls
  val inputKeyCalls by state::inputKeyCalls
  val toolCalls by state::toolCalls

  data class ToolCall(val name: String, val arguments: JsonObject)

  // -- Streamed gesture support --

  /** When false, [openGestureStream] returns null so callers exercise the atomic-swipe fallback. */
  var gestureStreamSupported by state::gestureStreamSupported

  var gestureFrameResult by state::gestureFrameResult

  /** Every stream opened via [openGestureStream], newest last, with its recorded frames. */
  val openedGestureStreams by state::openedGestureStreams

  sealed interface GestureFrame {
    data class Start(val gestureId: String, val x: Double, val y: Double) : GestureFrame

    data class Move(val gestureId: String, val x: Double, val y: Double) : GestureFrame

    data class End(val gestureId: String, val x: Double, val y: Double, val cancel: Boolean) :
      GestureFrame
  }

  inner class RecordingGestureStream : GestureInputStream {
    val frames = mutableListOf<GestureFrame>()
    var closed = false

    override fun start(gestureId: String, x: Double, y: Double): InputActionResult {
      frames.add(GestureFrame.Start(gestureId, x, y))
      return gestureFrameResult
    }

    override fun move(gestureId: String, x: Double, y: Double): InputActionResult {
      frames.add(GestureFrame.Move(gestureId, x, y))
      return gestureFrameResult
    }

    override fun end(
      gestureId: String,
      x: Double,
      y: Double,
      cancel: Boolean,
    ): InputActionResult {
      frames.add(GestureFrame.End(gestureId, x, y, cancel))
      return gestureFrameResult
    }

    override fun close() {
      closed = true
    }
  }

  // -- AutoMobileClient implementation --

  override fun ping() {
    calls.add("ping")
    pingResult()
  }

  override fun listResources(): List<McpResource> {
    calls.add("listResources")
    return listResourcesResult
  }

  override fun listResourceTemplates(): List<McpResourceTemplate> {
    calls.add("listResourceTemplates")
    return listResourceTemplatesResult
  }

  override fun listTools(): List<McpTool> {
    calls.add("listTools")
    return listToolsResult
  }

  override fun readResource(uri: String): List<McpResourceContent> {
    calls.add("readResource")
    throwOnReadResource?.let { throw it }
    return resourceResponses[uri] ?: emptyList()
  }

  /** deviceId passed to the most recent [listPerformanceAuditResults] call (null if unscoped). */
  var lastListPerformanceAuditResultsDeviceId by state::lastListPerformanceAuditResultsDeviceId

  override fun openGestureStream(platform: String, deviceId: String?): GestureInputStream? {
    calls.add("openGestureStream")
    if (!gestureStreamSupported) return null
    return RecordingGestureStream().also { openedGestureStreams.add(it) }
  }

  override fun callTool(name: String, arguments: JsonObject): JsonElement {
    calls.add("callTool")
    toolCalls.add(ToolCall(name, arguments))
    return callToolResult
  }

  override fun close() {
    calls.add("close")
  }
}
