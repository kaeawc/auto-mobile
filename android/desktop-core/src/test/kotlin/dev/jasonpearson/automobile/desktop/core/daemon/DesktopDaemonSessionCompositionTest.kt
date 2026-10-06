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
import kotlinx.coroutines.Dispatchers
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * #10237: the session loop heartbeats every [HEARTBEAT_MS] but must send `setActiveDevice` only
 * when the binding changes or was lost. Virtual time (`mainClock`) over the in-memory transport.
 */
@OptIn(ExperimentalTestApi::class)
class DesktopDaemonSessionCompositionTest {
  private val pixel = DesktopDaemonSessionBinding("emulator-5554", "android")
  private val pixelFold = DesktopDaemonSessionBinding("emulator-5556", "android")

  @Test
  fun `unchanged focus binds once across many heartbeat ticks`() = runComposeUiTest {
    val transport = RecordingTransport()
    val binding = mutableStateOf<DesktopDaemonSessionBinding?>(pixel)
    setContent { sessionHost(transport, binding) }
    mainClock.autoAdvance = false
    mainClock.advanceTimeByFrame()

    repeat(5) { tick() }

    assertEquals(listOf("emulator-5554"), transport.boundDevices())
    assertEquals(5, transport.count("daemon/heartbeat"))
  }

  @Test
  fun `a focus change binds the new device once`() = runComposeUiTest {
    val transport = RecordingTransport()
    val binding = mutableStateOf<DesktopDaemonSessionBinding?>(pixel)
    setContent { sessionHost(transport, binding) }
    mainClock.autoAdvance = false
    mainClock.advanceTimeByFrame()
    repeat(2) { tick() }

    binding.value = pixelFold
    mainClock.advanceTimeByFrame()
    repeat(3) { tick() }

    assertEquals(listOf("emulator-5554", "emulator-5556"), transport.boundDevices())
  }

  @Test
  fun `a lapsed heartbeat re-registers by re-sending the binding exactly once`() =
    runComposeUiTest {
      val transport = RecordingTransport()
      val binding = mutableStateOf<DesktopDaemonSessionBinding?>(pixel)
      setContent { sessionHost(transport, binding) }
      mainClock.autoAdvance = false
      mainClock.advanceTimeByFrame()
      repeat(2) { tick() }
      assertEquals(1, transport.boundDevices().size)

      // Daemon restart: the next heartbeat is refused, which loses the binding.
      transport.failNext("daemon/heartbeat")
      tick()
      assertEquals(listOf("emulator-5554", "emulator-5554"), transport.boundDevices())

      repeat(3) { tick() }
      assertEquals(2, transport.boundDevices().size)
    }

  @Test
  fun `a failed bind is retried on the next tick and then stops once acknowledged`() =
    runComposeUiTest {
      val transport = RecordingTransport()
      transport.failNext("tools/call:setActiveDevice")
      val binding = mutableStateOf<DesktopDaemonSessionBinding?>(pixel)
      setContent { sessionHost(transport, binding) }
      mainClock.autoAdvance = false
      mainClock.advanceTimeByFrame()
      assertEquals(1, transport.boundDevices().size)

      tick()
      assertEquals(2, transport.boundDevices().size)
      repeat(3) { tick() }
      assertEquals(2, transport.boundDevices().size)
    }

  @Test
  fun `a rejected bind result is retried on the next tick`() = runComposeUiTest {
    val transport = RecordingTransport(rejectBindsUntilAttempt = 2)
    val binding = mutableStateOf<DesktopDaemonSessionBinding?>(pixel)
    setContent { sessionHost(transport, binding) }
    mainClock.autoAdvance = false
    mainClock.advanceTimeByFrame()

    repeat(4) { tick() }

    assertEquals(2, transport.boundDevices().size)
  }

  private fun ComposeUiTest.tick() {
    mainClock.advanceTimeBy(HEARTBEAT_MS)
    mainClock.advanceTimeByFrame()
  }

  @Composable
  private fun sessionHost(
    transport: RecordingTransport,
    binding: MutableState<DesktopDaemonSessionBinding?>,
  ) {
    rememberDesktopDaemonSession(
      socketPath = "in-memory",
      binding = binding,
      sessionFactory = {
        DesktopDaemonSession(McpDaemonClient(transport, sessionUuid = "desktop-session"))
      },
      ioDispatcher = Dispatchers.Unconfined,
    )
  }

  private class RecordingTransport(private val rejectBindsUntilAttempt: Int = 0) :
    DaemonRequestTransport {
    private val calls = CopyOnWriteArrayList<Pair<String, String?>>()
    private val failures = CopyOnWriteArrayList<String>()
    private var bindAttempts = 0

    fun failNext(key: String) {
      failures.add(key)
    }

    fun count(method: String) = calls.count { it.first == method }

    fun boundDevices(): List<String> =
      calls.filter { it.second != null }.map { requireNotNull(it.second) }

    override fun send(request: DaemonRequest): DaemonResponse {
      val tool = request.params["name"]?.jsonPrimitive?.content
      val key = if (tool != null) "${request.method}:$tool" else request.method
      val device =
        if (tool == "setActiveDevice") {
          request.params["arguments"]?.jsonObject?.get("deviceId")?.jsonPrimitive?.content
        } else {
          null
        }
      calls.add(request.method to device)
      if (failures.remove(key)) {
        return DaemonResponse(
          id = request.id,
          type = "mcp_response",
          success = false,
          error = "daemon unavailable",
        )
      }
      return DaemonResponse(
        id = request.id,
        type = "mcp_response",
        success = true,
        result = DaemonJson.parseToJsonElement(resultFor(key)),
      )
    }

    private fun resultFor(key: String): String =
      when (key) {
        "tools/call:setActiveDevice" -> {
          bindAttempts++
          val success = bindAttempts >= rejectBindsUntilAttempt
          """{"content":[{"type":"text","text":"{\"success\":$success}"}]}"""
        }
        "daemon/registerSession" ->
          """{"accepted":true,"heartbeatTimeoutMs":10000,"expiresAtMs":12345}"""
        else -> "{}"
      }
  }

  private companion object {
    const val HEARTBEAT_MS = 2_000L
  }
}
