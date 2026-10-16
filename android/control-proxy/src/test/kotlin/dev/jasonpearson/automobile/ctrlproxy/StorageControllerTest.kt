package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.perf.TimeProvider
import dev.jasonpearson.automobile.ctrlproxy.storage.PreferenceChangeEvent
import dev.jasonpearson.automobile.ctrlproxy.storage.PreferenceEntry
import dev.jasonpearson.automobile.ctrlproxy.storage.PreferenceFileInfo
import dev.jasonpearson.automobile.ctrlproxy.storage.StorageSubscriptionManager
import dev.jasonpearson.automobile.protocol.ErrorResponse
import io.mockk.coEvery
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class StorageControllerTest {
  private class FakeTimer : TimeProvider {
    override fun currentTimeMillis() = 7_000L
  }

  private class FakeSender : StorageController.ResponseSender {
    var running = true
    var failing = false
    val messages = mutableListOf<String>()

    override fun isRunning() = running

    override suspend fun broadcast(message: String) {
      if (failing) error("socket gone")
      messages += message
    }

    override fun connectionCount() = 2
  }

  private val json = Json { encodeDefaults = true }
  private val manager = mockk<StorageSubscriptionManager>()
  private val sender = FakeSender()
  private val errors = mutableListOf<ErrorResponse>()

  private fun TestScopeHolder.controller() =
    StorageController(
      manager = { manager },
      asyncActionRunner =
        AsyncActionRunner(scope = scope, broadcastResponse = { errors += it as ErrorResponse }),
      resultBroadcaster =
        ResultBroadcaster(broadcastError = { errors += it }, logError = { _, _ -> }),
      timeProvider = FakeTimer(),
      jsonCompact = json,
      responseSender = sender,
    )

  private class TestScopeHolder(val scope: CoroutineScope)

  private fun frame(index: Int = 0): JsonObject =
    json.parseToJsonElement(sender.messages[index]).jsonObject

  private fun holder(testScope: kotlinx.coroutines.test.TestScope) =
    TestScopeHolder(CoroutineScope(UnconfinedTestDispatcher(testScope.testScheduler)))

  @Test
  fun `listing preference files broadcasts the files on success`() = runTest {
    coEvery { manager.listPreferenceFiles("com.app") } returns
      Result.success(listOf(PreferenceFileInfo("prefs", "/data/prefs.xml", 3)))

    holder(this).controller().handleListPreferenceFiles("r1", "com.app")

    val frame = frame()
    assertEquals("preference_files", frame["type"]!!.jsonPrimitive.content)
    assertEquals("r1", frame["requestId"]!!.jsonPrimitive.content)
    assertEquals(7_000L, frame["timestamp"]!!.jsonPrimitive.content.toLong())
    assertTrue(frame["success"]!!.jsonPrimitive.boolean)
    assertTrue(frame["files"]!!.toString().contains("\"entryCount\":3"))
  }

  @Test
  fun `a failed read broadcasts the error message`() = runTest {
    coEvery { manager.getPreferences("com.app", "prefs") } returns
      Result.failure(IllegalStateException("provider missing"))

    holder(this).controller().handleGetPreferences("r1", "com.app", "prefs")

    val frame = frame()
    assertEquals("preferences", frame["type"]!!.jsonPrimitive.content)
    assertFalse(frame["success"]!!.jsonPrimitive.boolean)
    assertEquals("provider missing", frame["error"]!!.jsonPrimitive.content)
    assertEquals("prefs", frame["fileName"]!!.jsonPrimitive.content)
  }

  @Test
  fun `a successful get returns the entries`() = runTest {
    coEvery { manager.getPreferences("com.app", "prefs") } returns
      Result.success(listOf(PreferenceEntry("k", "\"v\"", "STRING")))

    holder(this).controller().handleGetPreferences("r1", "com.app", "prefs")

    assertTrue(frame()["success"]!!.jsonPrimitive.boolean)
    assertTrue(sender.messages.single().contains("\"key\":\"k\""))
  }

  @Test
  fun `unsubscribe reports the manager's boolean`() = runTest {
    every { manager.unsubscribe("com.app", "prefs") } returns true

    holder(this).controller().handleUnsubscribeStorage("r1", "com.app", "prefs")

    val frame = frame()
    assertEquals("unsubscribe_storage_result", frame["type"]!!.jsonPrimitive.content)
    assertTrue(frame["success"]!!.jsonPrimitive.boolean)
  }

  @Test
  fun `nothing is sent while the socket server is not running`() = runTest {
    sender.running = false
    every { manager.unsubscribe("com.app", "prefs") } returns true

    holder(this).controller().handleUnsubscribeStorage("r1", "com.app", "prefs")

    assertTrue(sender.messages.isEmpty())
  }

  @Test
  fun `a storage change is encoded and a send failure is swallowed`() = runTest {
    val controller = holder(this).controller()
    val event =
      PreferenceChangeEvent(
        "com.app",
        "prefs",
        "k",
        "\"v\"",
        "STRING",
        timestamp = 1L,
        sequenceNumber = 1L,
      )

    controller.broadcastStorageChange(event)
    sender.failing = true
    controller.broadcastStorageChange(event)

    assertEquals("storage_changed", frame()["type"]!!.jsonPrimitive.content)
    assertEquals(1, sender.messages.size)
  }
}
