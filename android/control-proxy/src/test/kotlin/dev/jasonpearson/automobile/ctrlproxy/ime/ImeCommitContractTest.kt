package dev.jasonpearson.automobile.ctrlproxy.ime

import java.io.File
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Test

/** Pure contract tests: no service, input connection, Android runtime, or real clock required. */
class ImeCommitContractTest {
  @Test
  fun `device selects the positive host budget independently of unit count`() {
    assertEquals(14_500L, CtrlProxyIme.commitTimeoutMs(14_500L, 149))
    assertEquals(1L, CtrlProxyIme.commitTimeoutMs(1L, 149))
  }

  @Test
  fun `legacy budget scales with editing units and preserves the minimum`() {
    assertEquals(4_000L, CtrlProxyIme.commitTimeoutMs(null, 0))
    assertEquals(4_030L, CtrlProxyIme.commitTimeoutMs(null, 1))
    assertEquals(8_470L, CtrlProxyIme.commitTimeoutMs(null, 149))
  }

  @Test
  fun `both supplied and legacy budgets are capped without overflow`() {
    assertEquals(25_000L, CtrlProxyIme.commitTimeoutMs(25_001L, 1))
    assertEquals(25_000L, CtrlProxyIme.commitTimeoutMs(Long.MAX_VALUE, 1))
    assertEquals(25_000L, CtrlProxyIme.commitTimeoutMs(null, Int.MAX_VALUE))
  }

  @Test
  fun `nonpositive budgets fall back to the legacy default`() {
    for (timeoutMs in listOf(0L, -1L, Long.MIN_VALUE)) {
      assertEquals(8_470L, CtrlProxyIme.commitTimeoutMs(timeoutMs, 149))
    }
    assertEquals(4_000L, CtrlProxyIme.commitTimeoutMs(null, -1))
  }

  @Test
  fun `device constants match the shared contract`() {
    val device = contract.device
    assertEquals(device.pollIntervalMs, ImeCommitDriver.POLL_INTERVAL_MS)
    assertEquals(device.maxPollAttempts, ImeCommitDriver.MAX_POLL_ATTEMPTS)
    assertEquals(device.commitBudgetMs, CtrlProxyIme.COMMIT_TIMEOUT_MS)
    assertEquals(device.serviceReadyTimeoutMs, IME_SERVICE_READY_TIMEOUT_MS)
    assertEquals(device.serviceReadyPollMs, IME_SERVICE_READY_POLL_MS)
    assertEquals(device.inputConnectionTimeoutMs, CtrlProxyIme.INPUT_CONNECTION_TIMEOUT_MS)
    assertEquals(device.inputConnectionPollMs, CtrlProxyIme.INPUT_CONNECTION_POLL_MS)
  }

  @Test
  fun `runtime splitter matches every shared segment case`() {
    for (case in contract.segmentCases) {
      assertEquals(case.text, case.segments, ImeCommitDriver.segmentCount(case.text))
    }
  }

  @Test
  fun `legacy device self-bound fits within the host timeout for all shared cases`() {
    val host = contract.host
    for (text in (contract.segmentCases.map { it.text } + contract.timeoutCases.map { it.text })) {
      val segments = ImeCommitDriver.segmentCount(text)
      // Reads consume the active budget. Only scheduled settle waits extend it; this bound
      // assumes blocking reads eventually return. Activation/binding are separate budgets.
      // UTF-16 length conservatively bounds the number of Unicode editing units.
      val selfBound =
        CtrlProxyIme.commitTimeoutMs(null, text.length) +
          ImeCommitDriver.MAX_POLL_ATTEMPTS * ImeCommitDriver.POLL_INTERVAL_MS * (segments - 1)
      val hostTimeout =
        minOf(
          host.capMs,
          host.baseMs + host.perSegmentMs * (segments - 1) + host.perCharMs * text.length,
        )
      assertTrue(
        "self-bound $selfBound exceeds host timeout $hostTimeout for $text",
        selfBound <= hostTimeout,
      )
    }
    // For work whose settle extension alone exceeds the 25s host cap, host cancellation is
    // expected instead. This fixture deliberately keeps its cases within the invariant.
  }

  @Serializable
  private data class Contract(
    val host: Host,
    val device: Device,
    val segmentCases: List<SegmentCase>,
    val timeoutCases: List<TimeoutCase>,
  )

  @Serializable
  private data class Host(
    val baseMs: Long,
    val perSegmentMs: Long,
    val perCharMs: Long,
    val capMs: Long,
  )

  @Serializable
  private data class Device(
    val pollIntervalMs: Long,
    val maxPollAttempts: Int,
    val commitBudgetMs: Long,
    val serviceReadyTimeoutMs: Long,
    val serviceReadyPollMs: Long,
    val inputConnectionTimeoutMs: Long,
    val inputConnectionPollMs: Long,
  )

  @Serializable private data class SegmentCase(val text: String, val segments: Int)

  @Serializable private data class TimeoutCase(val text: String, val hostTimeoutMs: Long)

  companion object {
    private lateinit var contract: Contract

    @BeforeClass
    @JvmStatic
    fun loadContract() {
      // Same ancestor search as control-proxy's TapGestureCompletionWiringTest: works from
      // the repo root, android/, or android/control-proxy/. Parse once outside test timing.
      val relativePath = "test/fixtures/ime-commit-contract.json"
      var directory: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
      while (directory != null) {
        val candidate = File(directory, relativePath)
        if (candidate.isFile) {
          contract =
            Json { ignoreUnknownKeys = true }.decodeFromString<Contract>(candidate.readText())
          ImeCommitDriver.segmentCount("") // Initialize the runtime regex outside test timing.
          return
        }
        directory = directory.parentFile
      }
      error("Could not locate $relativePath from user.dir=${System.getProperty("user.dir")}")
    }
  }
}
