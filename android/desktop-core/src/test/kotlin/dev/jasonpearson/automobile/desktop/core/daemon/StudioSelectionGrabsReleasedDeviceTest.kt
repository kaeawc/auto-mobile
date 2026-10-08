package dev.jasonpearson.automobile.desktop.core.daemon

import androidx.compose.runtime.Composable
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.runComposeUiTest
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.coroutines.Dispatchers
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Hypothesis H5 ("studio selection is allocation"), client side.
 *
 * Drives the REAL [rememberDesktopDaemonSession] loop, [DesktopDaemonSession],
 * [DesktopSessionRegistration] and [McpDaemonClient] (wire encoding + tool-error decoding) on the
 * Compose virtual clock. Only the daemon is modeled, by [OwnerModelingDaemon]: one device that
 * refuses `setActiveDevice` while another live session owns it and binds it to the caller as soon
 * as it is free, answering with the envelopes the TypeScript daemon produces. The daemon half is
 * proven against the real TypeScript daemon in test/daemon/studioSelectionHoldsDevice.test.ts.
 *
 * CURRENT (bug/gap) behavior asserted: a selection with no user action (the IDE's auto-select,
 * AutoMobileContent.kt:1032-1036) re-sends `setActiveDevice` every 2 s pass while refused, takes
 * the device on the first pass after the agent releases it, and then holds it with a heartbeat
 * every 2 s for as long as the window stays open, never releasing it.
 */
@OptIn(ExperimentalTestApi::class)
class StudioSelectionGrabsReleasedDeviceTest {

  @Test
  fun `IDE auto-selection takes the device within one pass of the agent's release and holds it`() =
    runComposeUiTest {
      val daemon = OwnerModelingDaemon(owner = AGENT) { mainClock.currentTime }
      val binding = mutableStateOf<DesktopDaemonSessionBinding?>(null)
      setContent { studioHost(daemon, binding) }
      mainClock.autoAdvance = false
      mainClock.advanceTimeByFrame()
      tick()
      // Binding is null until the booted-devices read resolves: observer registration only.
      assertEquals(1, daemon.count("daemon/registerSession", ok = true))
      assertEquals(AGENT, daemon.owner)

      // AutoMobileContent.kt:1032-1036 sets activeDeviceId = firstDevice.id with no click; :840-858
      // turns it into this binding.
      binding.value = DesktopDaemonSessionBinding(DEVICE, "android")
      mainClock.advanceTimeByFrame()
      repeat(REFUSED_PASSES) { tick() }

      // Refused on every pass, and the loop never backs off (observer heartbeats succeed).
      assertTrue(daemon.count(SET_ACTIVE_DEVICE, ok = false) >= REFUSED_PASSES)
      assertEquals(0, daemon.count(SET_ACTIVE_DEVICE, ok = true))
      assertEquals(0, daemon.count("daemon/heartbeat", ok = false))

      // The agent finishes; its session ends and the device is free.
      val releasedAtMs = mainClock.currentTime
      daemon.owner = null
      tick()

      assertEquals(STUDIO, daemon.owner)
      val bindAtMs = daemon.frames.first { it.key == SET_ACTIVE_DEVICE && it.ok }.atMs
      assertTrue(
        bindAtMs - releasedAtMs <= LOOP_MS,
        "bound ${bindAtMs - releasedAtMs}ms after release",
      )

      // Ten minutes with no user action: heartbeat every pass, no re-bind, no release. (Compose
      // frames make each virtual pass cost ~25 ms of wall time; the hour-long hold against the real
      // daemon is in test/daemon/studioSelectionHoldsDevice.test.ts.)
      val bindsBefore = daemon.count(SET_ACTIVE_DEVICE)
      val heartbeatsBefore = daemon.count("daemon/heartbeat", ok = true)
      repeat(HOLD_PASSES) { tick() }
      assertEquals(bindsBefore, daemon.count(SET_ACTIVE_DEVICE))
      assertTrue(daemon.count("daemon/heartbeat", ok = true) - heartbeatsBefore >= HOLD_PASSES)
      assertEquals(0, daemon.count("daemon/heartbeat", ok = false))
      assertEquals(0, daemon.count("daemon/releaseSession"))
      assertEquals(STUDIO, daemon.owner)
      // AFTER A FIX (auto-selection or a focused view no longer allocates): the device is never
      // bound to the studio, e.g. assertEquals(0, daemon.count(SET_ACTIVE_DEVICE, ok = true)) and
      // daemon.owner stays null so the next agent can take it.
    }

  @Test
  fun `a focused pane with no observer registration knocks every pass and grabs the device`() =
    runComposeUiTest {
      val daemon = OwnerModelingDaemon(owner = AGENT) { mainClock.currentTime }
      val binding =
        mutableStateOf<DesktopDaemonSessionBinding?>(DesktopDaemonSessionBinding(DEVICE, "android"))
      setContent { studioHost(daemon, binding) }
      mainClock.autoAdvance = false
      mainClock.advanceTimeByFrame()
      repeat(REFUSED_PASSES) { tick() }

      // With no device session and no observer entry the heartbeat fails "Session not found",
      // which only resets bindingAcknowledged: the bind is re-sent at the 2 s cadence regardless.
      assertTrue(daemon.count(SET_ACTIVE_DEVICE, ok = false) >= REFUSED_PASSES)
      assertTrue(daemon.count("daemon/heartbeat", ok = false) >= REFUSED_PASSES - 1)
      val refusedBinds = daemon.frames.filter { it.key == SET_ACTIVE_DEVICE }.map { it.atMs }
      assertTrue(refusedBinds.zipWithNext { a, b -> b - a }.all { it <= LOOP_MS + FRAME_SLACK_MS })

      daemon.owner = null
      tick()
      assertEquals(STUDIO, daemon.owner)
      repeat(SHORT_HOLD_PASSES) { tick() }
      assertEquals(STUDIO, daemon.owner)
      assertEquals(1, daemon.count(SET_ACTIVE_DEVICE, ok = true))
      // AFTER A FIX: a refused bind is not retried into an allocation once the owner leaves.
    }

  private fun ComposeUiTest.tick() {
    mainClock.advanceTimeBy(LOOP_MS)
    mainClock.advanceTimeByFrame()
  }

  @Composable
  private fun studioHost(
    daemon: OwnerModelingDaemon,
    binding: MutableState<DesktopDaemonSessionBinding?>,
  ) {
    rememberDesktopDaemonSession(
      socketPath = "in-memory",
      binding = binding,
      sessionFactory = { DesktopDaemonSession(McpDaemonClient(daemon, sessionUuid = STUDIO)) },
      ioDispatcher = Dispatchers.Unconfined,
    )
  }

  private companion object {
    const val LOOP_MS = 2_000L // DesktopDaemonSessionComposition.kt:28
    const val FRAME_SLACK_MS = 32L
    const val REFUSED_PASSES = 15
    const val HOLD_PASSES = 300
    const val SHORT_HOLD_PASSES = 60
    const val DEVICE = "emulator-5554"
    const val AGENT = "agent-session-1"
    const val STUDIO = "5d1f0c7e-4a43-4f7a-9d0e-3c0a2b9f6a11"
    const val SET_ACTIVE_DEVICE = "tools/call:setActiveDevice"
  }
}

/**
 * One-device model of the daemon's ownership answers, using the TypeScript daemon's envelopes:
 * - `setActiveDevice` refused while another session owns the device (setActiveDevice.ts:70-85)
 *   comes back as a success envelope carrying an `isError` tool result whose text is
 *   `Error: <message>` (shapeToolCallError.ts:68, src/server/index.ts:1696-1699,
 *   socketServer.ts:2017-2022); a free device is bound to the caller (setActiveDevice.ts:206-212).
 * - `daemon/heartbeat` succeeds for the owning session or a registered observer, otherwise fails
 *   `Session not found` (daemonRequestHandlers.ts handleHeartbeat). Binding a device session
 *   removes the caller's observer entry (src/daemon/CLAUDE.md, registration-only sessions).
 */
internal class OwnerModelingDaemon(var owner: String?, private val clock: () -> Long) :
  DaemonRequestTransport {
  data class Frame(val atMs: Long, val key: String, val ok: Boolean)

  val frames = CopyOnWriteArrayList<Frame>()
  private val observers = mutableSetOf<String>()

  fun count(key: String, ok: Boolean? = null): Int =
    frames.count { it.key == key && (ok == null || it.ok == ok) }

  override fun send(request: DaemonRequest): DaemonResponse {
    val tool = request.params["name"]?.jsonPrimitive?.content
    val key = if (tool != null) "${request.method}:$tool" else request.method
    val sessionId = request.params["sessionId"]?.jsonPrimitive?.content
    val response =
      when (key) {
        "daemon/registerSession" -> {
          observers.add(requireNotNull(sessionId))
          ok(request, """{"accepted":true,"heartbeatTimeoutMs":10000,"expiresAtMs":0}""")
        }
        "daemon/heartbeat" ->
          if (sessionId == owner || sessionId in observers) {
            ok(request, """{"sessionId":"$sessionId"}""")
          } else {
            fail(request, "Session not found: $sessionId")
          }
        "daemon/releaseSession" -> {
          if (sessionId == owner) owner = null
          observers.remove(sessionId)
          ok(request, """{"alreadyReleased":false}""")
        }
        "tools/call:setActiveDevice" -> setActiveDevice(request)
        else -> ok(request, "{}")
      }
    frames.add(Frame(clock(), key, response.second))
    return response.first
  }

  private fun setActiveDevice(request: DaemonRequest): Pair<DaemonResponse, Boolean> {
    val arguments = request.params["arguments"]?.jsonObject ?: JsonObject(emptyMap())
    val caller = requireNotNull(arguments["sessionUuid"]?.jsonPrimitive?.content)
    val deviceId = requireNotNull(arguments["deviceId"]?.jsonPrimitive?.content)
    val current = owner
    if (current != null && current != caller) {
      val text = "Error: Device '$deviceId' is already assigned to session $current"
      return toolResult(request, text, isError = true) to false
    }
    owner = caller
    observers.remove(caller)
    val payload = buildJsonObject {
      put("message", JsonPrimitive("Active device set to '$deviceId'"))
      put("deviceId", JsonPrimitive(deviceId))
      put("sessionUuid", JsonPrimitive(caller))
    }
    return toolResult(request, payload.toString(), isError = false) to true
  }

  private fun toolResult(
    request: DaemonRequest,
    text: String,
    isError: Boolean,
  ): DaemonResponse {
    val result = buildJsonObject {
      put(
        "content",
        JsonArray(
          listOf(
            buildJsonObject {
              put("type", JsonPrimitive("text"))
              put("text", JsonPrimitive(text))
            }
          )
        ),
      )
      if (isError) put("isError", JsonPrimitive(true))
    }
    return DaemonResponse(id = request.id, type = "mcp_response", success = true, result = result)
  }

  private fun ok(request: DaemonRequest, json: String): Pair<DaemonResponse, Boolean> =
    DaemonResponse(
      id = request.id,
      type = "mcp_response",
      success = true,
      result = DaemonJson.parseToJsonElement(json),
    ) to true

  private fun fail(request: DaemonRequest, error: String): Pair<DaemonResponse, Boolean> =
    DaemonResponse(id = request.id, type = "mcp_response", success = false, error = error) to false
}
