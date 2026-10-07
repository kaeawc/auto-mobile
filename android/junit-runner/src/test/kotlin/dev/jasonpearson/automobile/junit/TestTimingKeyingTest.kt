package dev.jasonpearson.automobile.junit

import java.io.Closeable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Ignore
import org.junit.Test

/**
 * Timing history must be loaded without scoping it to the runner's own fresh session UUID, and it
 * is keyed by fully qualified class name (issue #10091).
 */
class TestTimingKeyingTest {
  private lateinit var daemon: TimingFakeDaemonClient

  @Before
  fun setup() {
    daemon = TimingFakeDaemonClient()
    DaemonSocketClientManager.testClient = daemon
    AutoMobileSharedUtils.testDeviceChecker = TimingFakeDeviceChecker()
    DaemonHeartbeat.testController = TimingFakeHeartbeat()
    AutoMobilePlanExecutor.testAgent =
      AutoMobileAgent(recoveryConfigProvider = StaticRecoveryConfigProvider(enabled = false))
    TestTimingCache.testCiModeOverride = false
    SystemPropertyCache.clear()
    TestTimingCache.clear()
  }

  @After
  fun tearDown() {
    DaemonSocketClientManager.testClient = null
    AutoMobileSharedUtils.testDeviceChecker = null
    DaemonHeartbeat.testController = null
    AutoMobilePlanExecutor.testAgent = null
    TestTimingCache.testCiModeOverride = null
    System.clearProperty("automobile.junit.timing.ordering")
    SystemPropertyCache.clear()
    TestTimingCache.clear()
  }

  @Test
  fun `timing request is not scoped to the caller's fresh session`() {
    daemon.sessionUuid = "fresh-jvm-session"
    daemon.timings = listOf(timing("com.app.login.SmokeTest", "opensHome", 500))

    assertTrue(TestTimingCache.hasTimings())

    val uri = daemon.readUris.single()
    assertTrue(uri, uri.startsWith("automobile:test-timings?"))
    assertTrue(uri, uri.contains("devicePlatform=android"))
    assertFalse(uri, uri.contains("sessionUuid"))
    assertFalse(uri, uri.contains("fresh-jvm-session"))
  }

  @Test
  fun `getTiming prefers the fully qualified row and falls back to a pre-fix simple name row`() {
    daemon.timings =
      listOf(
        timing("com.app.login.SmokeTest", "opensHome", 500),
        timing("SmokeTest", "opensHome", 9000),
        timing("SmokeTest", "legacyOnly", 700),
      )

    val qualified =
      TestTimingCache.getTiming(
        "com.app.login.SmokeTest",
        "opensHome",
        legacySimpleName = "SmokeTest",
      )
    val legacy =
      TestTimingCache.getTiming(
        "com.app.login.SmokeTest",
        "legacyOnly",
        legacySimpleName = "SmokeTest",
      )
    val noFallback = TestTimingCache.getTiming("com.app.login.SmokeTest", "legacyOnly")

    assertEquals(500, qualified?.averageDurationMs)
    assertEquals(700, legacy?.averageDurationMs)
    assertNull(noFallback)
  }

  @Test
  fun `the runner orders methods by history recorded under the fully qualified name`() {
    System.setProperty("automobile.junit.timing.ordering", "shortest-first")
    daemon.timings =
      listOf(
        timing(RunnerTestTarget::class.java.name, "testLaunchClockApp", 900),
        timing(RunnerTestTarget::class.java.name, "testSetAlarm", 100),
      )

    val order =
      AutoMobileRunner(RunnerTestTarget::class.java).description.children.map { it.methodName }

    assertEquals(listOf("testSetAlarm", "testLaunchClockApp"), order)
  }

  @Test
  fun `the runner still orders by history recorded under the simple name before the fix`() {
    System.setProperty("automobile.junit.timing.ordering", "shortest-first")
    daemon.timings =
      listOf(
        timing("RunnerTestTarget", "testLaunchClockApp", 900),
        timing("RunnerTestTarget", "testSetAlarm", 100),
      )

    val order =
      AutoMobileRunner(RunnerTestTarget::class.java).description.children.map { it.methodName }

    assertEquals(listOf("testSetAlarm", "testLaunchClockApp"), order)
  }

  @Test
  fun `same-named test classes in different packages record different testClass values`() {
    daemon.executePlanResponse = successResponse()

    PlanRecordingAlpha.SmokeCase().runsPlan()
    PlanRecordingBeta.SmokeCase().runsPlan()

    val recorded =
      daemon.executePlanArgs.map {
        it["testMetadata"]!!.jsonObject["testClass"]!!.jsonPrimitive.content
      }
    assertEquals(
      listOf(
        PlanRecordingAlpha.SmokeCase::class.java.name,
        PlanRecordingBeta.SmokeCase::class.java.name,
      ),
      recorded,
    )
    assertNotEquals(recorded[0], recorded[1])
    assertTrue(recorded.all { it.contains('.') })
  }

  private fun timing(testClass: String, testMethod: String, averageMs: Int) =
    JsonObject(
      mapOf(
        "testClass" to JsonPrimitive(testClass),
        "testMethod" to JsonPrimitive(testMethod),
        "averageDurationMs" to JsonPrimitive(averageMs),
        "sampleSize" to JsonPrimitive(1),
      )
    )

  private fun successResponse(): DaemonResponse =
    DaemonResponse(
      id = "ok",
      type = "mcp_response",
      success = true,
      result =
        JsonObject(
          mapOf(
            "content" to
              JsonArray(
                listOf(
                  JsonObject(
                    mapOf(
                      "type" to JsonPrimitive("text"),
                      "text" to
                        JsonPrimitive("""{"success":true,"executedSteps":1,"totalSteps":1}"""),
                    )
                  )
                )
              )
          )
        ),
    )
}

/**
 * Two same-simple-name classes whose @Test methods run a plan; skipped when Gradle discovers them.
 */
object PlanRecordingAlpha {
  class SmokeCase {
    @Test
    @Ignore("Driven directly by TestTimingKeyingTest")
    fun runsPlan() {
      AutoMobilePlanExecutor.execute(
        "test-plans/launch-clock-app.yaml",
        emptyMap(),
        AutoMobilePlanExecutionOptions(aiAssistance = false),
      )
    }
  }
}

object PlanRecordingBeta {
  class SmokeCase {
    @Test
    @Ignore("Driven directly by TestTimingKeyingTest")
    fun runsPlan() {
      AutoMobilePlanExecutor.execute(
        "test-plans/launch-clock-app.yaml",
        emptyMap(),
        AutoMobilePlanExecutionOptions(aiAssistance = false),
      )
    }
  }
}

private class TimingFakeDaemonClient : DaemonToolClient {
  var timings: List<JsonObject> = emptyList()
  var executePlanResponse: DaemonResponse? = null
  val readUris = mutableListOf<String>()
  val executePlanArgs = mutableListOf<JsonObject>()
  override var sessionUuid: String = "test-session"

  override fun callTool(toolName: String, arguments: JsonObject, timeoutMs: Long): DaemonResponse {
    if (toolName == "executePlan") {
      executePlanArgs.add(arguments)
      return checkNotNull(executePlanResponse)
    }
    return DaemonResponse(id = "ok", type = "mcp_response", success = true)
  }

  override fun readResource(uri: String, timeoutMs: Long): DaemonResponse {
    readUris.add(uri)
    val summary = JsonObject(mapOf("testTimings" to JsonArray(timings)))
    val contents = JsonArray(listOf(JsonObject(mapOf("text" to JsonPrimitive(summary.toString())))))
    return DaemonResponse(
      id = "timings",
      type = "mcp_response",
      success = true,
      result = JsonObject(mapOf("contents" to contents)),
    )
  }
}

private class TimingFakeDeviceChecker : DeviceChecker {
  override fun checkDeviceAvailability() = Unit

  override fun areDevicesAvailable(): Boolean = true

  override fun getDeviceCount(): Int = 1
}

private class TimingFakeHeartbeat : DaemonHeartbeatController {
  override fun startBackground(intervalMs: Long) = Closeable {}

  override fun registerSession(sessionId: String) = Unit

  override fun unregisterSession(sessionId: String) = Unit
}
