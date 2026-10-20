package dev.jasonpearson.automobile.ctrlproxy

import android.provider.Settings
import dev.jasonpearson.automobile.ctrlproxy.perf.PerfProvider
import dev.jasonpearson.automobile.ctrlproxy.perf.TimeProvider
import dev.jasonpearson.automobile.protocol.ErrorResponse
import dev.jasonpearson.automobile.protocol.SettingsGetResult
import dev.jasonpearson.automobile.protocol.SettingsListResult
import dev.jasonpearson.automobile.protocol.SettingsPutResult
import dev.jasonpearson.automobile.protocol.WebSocketResponse
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

// Robolectric backs Settings.System/Secure/Global with a real in-memory ContentResolver.
@RunWith(RobolectricTestRunner::class)
class SettingsControllerTest {
  private class FakeTimer : TimeProvider {
    override fun currentTimeMillis() = 5_000L
  }

  private class FakeSender : SettingsController.ResponseSender {
    var running = true
    val frames = mutableListOf<WebSocketResponse>()

    override fun isRunning() = running

    override suspend fun broadcast(response: WebSocketResponse) {
      frames += response
    }
  }

  private val sender = FakeSender()
  private val errors = mutableListOf<ErrorResponse>()
  private val resolver = RuntimeEnvironment.getApplication().contentResolver
  private val timer = FakeTimer()
  private val controller =
    SettingsController(
      contentResolver = { resolver },
      perfProvider = PerfProvider.createForTesting(timer),
      timeProvider = timer,
      resultBroadcaster =
        ResultBroadcaster(broadcastError = { errors += it }, logError = { _, _ -> }),
      responseSender = sender,
    )

  @Test
  fun `read returns a stored value and marks it found`() = runTest {
    Settings.System.putString(resolver, "user_rotation", "1")

    controller.performSettingsRead("r1", "system", "user_rotation")

    val frame = sender.frames.single() as SettingsGetResult
    assertTrue(frame.success)
    assertTrue(frame.found)
    assertEquals("1", frame.value)
    assertEquals("r1", frame.requestId)
    assertEquals(5_000L, frame.timestamp)
  }

  @Test
  fun `read of an absent key succeeds without being found`() = runTest {
    controller.performSettingsRead("r1", "global", "missing_key")

    val frame = sender.frames.single() as SettingsGetResult
    assertTrue(frame.success)
    assertFalse(frame.found)
    assertNull(frame.value)
  }

  @Test
  fun `unknown namespaces fail with the existing text for read, write and list`() = runTest {
    controller.performSettingsRead("r1", "bogus", "k")
    controller.performSettingsWrite("r2", "bogus", "k", "v", "string")
    controller.performSettingsList("r3", "bogus")

    val (read, write, list) = sender.frames
    assertEquals("Unknown namespace: bogus", (read as SettingsGetResult).error)
    assertFalse(read.success)
    assertEquals("Unknown namespace: bogus", (write as SettingsPutResult).error)
    assertFalse(write.success)
    assertEquals("Unknown namespace: bogus", (list as SettingsListResult).error)
    assertFalse(list.success)
  }

  @Test
  fun `typed writes parse int long and float and reject malformed numbers`() = runTest {
    controller.performSettingsWrite("w1", "system", "int_key", "42", "int")
    controller.performSettingsWrite("w2", "system", "long_key", "9000000000", "long")
    controller.performSettingsWrite("w3", "system", "float_key", "1.5", "float")
    controller.performSettingsWrite("w4", "system", "bad_key", "x", "int")

    val frames = sender.frames.map { it as SettingsPutResult }
    assertEquals(listOf(true, true, true, false), frames.map { it.success })
    assertEquals("Invalid int value: x", frames[3].error)
    assertEquals(42, Settings.System.getInt(resolver, "int_key"))
    assertEquals(9_000_000_000L, Settings.System.getLong(resolver, "long_key"))
    assertEquals(1.5f, Settings.System.getFloat(resolver, "float_key"), 0f)
  }

  @Test
  fun `list succeeds with an empty map when the provider returns no cursor`() = runTest {
    // Robolectric's Settings provider does not serve queries, which is the null-cursor path.
    controller.performSettingsList("l1", "global")

    val frame = sender.frames.single() as SettingsListResult
    assertTrue(frame.success)
    assertEquals(emptyMap<String, String>(), frame.entries)
    assertNull(frame.error)
  }

  @Test
  fun `nothing is sent while the socket server is not running`() = runTest {
    sender.running = false

    controller.performSettingsRead("r1", "system", "user_rotation")

    assertTrue(sender.frames.isEmpty())
  }
}
