package dev.jasonpearson.automobile.junit

import java.io.ByteArrayOutputStream
import java.io.PrintStream
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Test

class DaemonRecoveryConfigProviderTest {
  companion object {
    @BeforeClass
    @JvmStatic
    fun initializeFixtureRuntime() {
      // Initialize the instrumented Kotlin/JSON classes once, outside per-test timing. This
      // synthetic read uses the same fake seam as the tests and never contacts the daemon.
      val fixtures = DaemonRecoveryConfigProviderTest()
      fixtures.providerFor(fixtures.textResponse("{}")).getMaxRecoveryToolCalls()
    }
  }

  @Test
  fun `both accessors share a read until the exact TTL boundary`() {
    var now = 1000L
    val reader =
      FakeRecoveryConfigResourceReader(
        { textResponse("""{"enabled":false,"config":{"maxToolCalls":9}}""") },
        { textResponse("""{"enabled":true,"config":{"maxToolCalls":7}}""") },
      )
    val provider = DaemonRecoveryConfigProvider(cacheTtlMs = 100L, clock = { now }, reader = reader)

    assertFalse(provider.isRecoveryEnabled())
    assertEquals(9, provider.getMaxRecoveryToolCalls())
    now += 99L
    assertEquals(9, provider.getMaxRecoveryToolCalls())
    assertFalse(provider.isRecoveryEnabled())
    assertEquals(1, reader.calls.size)

    now += 1L
    assertEquals(7, provider.getMaxRecoveryToolCalls())
    assertTrue(provider.isRecoveryEnabled())
    assertEquals(
      List(2) { "automobile:config/feature-flags/ai-recovery" to 5000L },
      reader.calls,
    )
  }

  @Test
  fun `failed reads are cached and refreshed after TTL`() {
    var now = 0L
    val reader =
      FakeRecoveryConfigResourceReader(
        { response(success = false) },
        { textResponse("""{"enabled":false,"config":{"maxToolCalls":9}}""") },
      )
    val provider = DaemonRecoveryConfigProvider(cacheTtlMs = 100L, clock = { now }, reader = reader)

    assertDefaults(provider)
    now = 99L
    assertDefaults(provider)
    assertEquals(1, reader.calls.size)
    now = 101L
    assertFalse(provider.isRecoveryEnabled())
    assertEquals(9, provider.getMaxRecoveryToolCalls())
    assertEquals(2, reader.calls.size)
  }

  @Test
  fun `unsuccessful response ignores otherwise valid values`() {
    assertDefaultsFor(textResponse("""{"enabled":false,"config":{"maxToolCalls":9}}""", false))
  }

  @Test
  fun `null result uses defaults`() {
    assertDefaultsFor(response())
  }

  @Test
  fun `missing contents uses defaults`() {
    assertDefaultsFor(response(JsonObject(emptyMap())))
  }

  @Test
  fun `non-array contents uses defaults`() {
    assertDefaultsFor(response(JsonObject(mapOf("contents" to JsonPrimitive("not an array")))))
  }

  @Test
  fun `empty contents uses defaults`() {
    assertDefaultsFor(response(JsonObject(mapOf("contents" to JsonArray(emptyList())))))
  }

  @Test
  fun `content without text uses defaults`() {
    assertDefaultsFor(
      response(JsonObject(mapOf("contents" to JsonArray(listOf(JsonObject(emptyMap())))))),
    )
  }

  @Test
  fun `missing enabled defaults to true while preserving max calls`() {
    val provider = providerFor(textResponse("""{"config":{"maxToolCalls":9}}"""))
    assertTrue(provider.isRecoveryEnabled())
    assertEquals(9, provider.getMaxRecoveryToolCalls())
  }

  @Test
  fun `missing config defaults to five while preserving disabled flag`() {
    val provider = providerFor(textResponse("""{"enabled":false}"""))
    assertFalse(provider.isRecoveryEnabled())
    assertEquals(5, provider.getMaxRecoveryToolCalls())
  }

  @Test
  fun `non-integer string max calls uses default`() {
    val provider =
      providerFor(textResponse("""{"enabled":false,"config":{"maxToolCalls":"abc"}}"""))
    assertFalse(provider.isRecoveryEnabled())
    assertEquals(5, provider.getMaxRecoveryToolCalls())
  }

  @Test
  fun `fractional max calls uses default without truncating`() {
    val provider = providerFor(textResponse("""{"enabled":false,"config":{"maxToolCalls":1.5}}"""))
    assertFalse(provider.isRecoveryEnabled())
    assertEquals(5, provider.getMaxRecoveryToolCalls())
  }

  @Test
  fun `malformed JSON prints warning and caches defaults`() {
    val reader = FakeRecoveryConfigResourceReader({ textResponse("{") })
    assertWarningAndCachedDefaults(reader)
  }

  @Test
  fun `reader exception prints warning and caches defaults`() {
    val reader =
      FakeRecoveryConfigResourceReader({ throw IllegalStateException("synthetic read failure") })
    assertWarningAndCachedDefaults(reader)
  }

  private fun assertDefaultsFor(response: DaemonResponse) {
    assertDefaults(providerFor(response))
  }

  private fun providerFor(response: DaemonResponse): DaemonRecoveryConfigProvider =
    DaemonRecoveryConfigProvider(
      clock = { 0L },
      reader = FakeRecoveryConfigResourceReader({ response }),
    )

  private fun assertDefaults(provider: DaemonRecoveryConfigProvider) {
    assertTrue(provider.isRecoveryEnabled())
    assertEquals(5, provider.getMaxRecoveryToolCalls())
  }

  private fun assertWarningAndCachedDefaults(reader: FakeRecoveryConfigResourceReader) {
    val provider = DaemonRecoveryConfigProvider(clock = { 0L }, reader = reader)
    // Gradle forks have separate System.out streams; JUnit Vintage runs tests serially within
    // each fork. This capture relies on that existing configuration, as other stdout tests do.
    val originalOut = System.out
    val captured = ByteArrayOutputStream()
    PrintStream(captured, true, Charsets.UTF_8).use { output ->
      try {
        System.setOut(output)
        assertDefaults(provider)
        assertDefaults(provider)
      } finally {
        System.setOut(originalOut)
      }
    }
    assertEquals(1, reader.calls.size)
    assertTrue(
      captured
        .toString(Charsets.UTF_8)
        .startsWith("Warning: Failed to read ai-recovery config from daemon:"),
    )
  }

  private fun textResponse(text: String, success: Boolean = true): DaemonResponse =
    response(
      JsonObject(
        mapOf("contents" to JsonArray(listOf(JsonObject(mapOf("text" to JsonPrimitive(text)))))),
      ),
      success,
    )

  private fun response(result: JsonElement? = null, success: Boolean = true): DaemonResponse =
    DaemonResponse(
      id = "synthetic-recovery-config",
      type = "mcp_response",
      success = success,
      result = result,
    )
}

private class FakeRecoveryConfigResourceReader(vararg reads: () -> DaemonResponse) :
  RecoveryConfigResourceReader {
  private val scriptedReads = reads.toList()
  val calls = mutableListOf<Pair<String, Long>>()

  override fun read(uri: String, timeoutMs: Long): DaemonResponse {
    calls.add(uri to timeoutMs)
    return scriptedReads[calls.lastIndex]()
  }
}
