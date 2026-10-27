package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.ime.ImeCommitRequest
import dev.jasonpearson.automobile.ctrlproxy.ime.ImeCommitResult
import dev.jasonpearson.automobile.ctrlproxy.ime.keyboard.profile.KeyboardProfiles
import dev.jasonpearson.automobile.ctrlproxy.ime.session.KeyboardProfileStore
import dev.jasonpearson.automobile.ctrlproxy.perf.TimeProvider
import dev.jasonpearson.automobile.protocol.RequestCommitText
import dev.jasonpearson.automobile.protocol.SetKeyboardProfileResult
import dev.jasonpearson.automobile.protocol.WebSocketResponse
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class ImeControllerTest {
  private class FakeTimer : TimeProvider {
    override fun currentTimeMillis(): Long = 1_000L
  }

  private class FakeStore(var active: String = KeyboardProfiles.DEFAULT.id) : KeyboardProfileStore {
    override fun activeProfileId() = active

    override fun setActiveProfileId(id: String) {
      active = id
    }
  }

  private class FakeIme(var result: ImeCommitResult) : ImeController.ImeTarget {
    var committed: String? = null

    override fun commitText(request: ImeCommitRequest, onResult: (ImeCommitResult) -> Unit) {
      committed = request.text
      onResult(result)
    }
  }

  private class FakeHost(val scope: CoroutineScope, val store: FakeStore) : ImeController.Host {
    var ime: FakeIme? = null
    var liveProfile = false
    var forgets = 0

    override fun launchRequestScope(requestId: String?, block: suspend CoroutineScope.() -> Unit) {
      scope.launch(block = block)
    }

    override fun currentIme(): ImeController.ImeTarget? = ime

    override fun setActiveProfile(id: String, onComplete: (Boolean) -> Unit): Boolean {
      if (liveProfile) onComplete(true)
      return liveProfile
    }

    override fun keyboardProfileStore() = store

    override fun forgetRememberedInsert() {
      forgets++
    }
  }

  private class FakeSender : FakeResultTransport() {
    val frames = mutableListOf<Pair<String, kotlinx.serialization.json.JsonObject>>()
    val profileResults = mutableListOf<SetKeyboardProfileResult>()

    override suspend fun sendFrame(frame: String) {
      val parsed = Json.parseToJsonElement(frame).jsonObject
      val type = parsed.getValue("type").jsonPrimitive.content
      frames += type to JsonObject(parsed - setOf("type", "timestamp", "perfTiming", "requestId"))
    }

    override suspend fun send(response: WebSocketResponse) {
      profileResults += response as SetKeyboardProfileResult
    }
  }

  private class Fixture(
    val host: FakeHost,
    val sender: FakeSender,
    val controller: ImeController,
    val clock: LongArray,
  )

  private fun TestScope.fixture(): Fixture {
    val store = FakeStore()
    val host = FakeHost(this, store)
    val sender = FakeSender()
    val clock = longArrayOf(0L)
    val controller =
      ImeController(
        host = host,
        timeProvider = FakeTimer(),
        jsonCompact = Json { encodeDefaults = true },
        resultSender =
          guardedResultSender(
            sender,
            ResultBroadcaster(broadcastError = {}, logError = { _, _ -> }),
          ),
        config =
          ImeConfig(
            uptimeMillis = { clock[0] },
            pause = { clock[0] += it },
          ),
      )
    return Fixture(host, sender, controller, clock)
  }

  @Test
  fun `commit text delivers through the ime and broadcasts a correlated result`() = runTest {
    val f = fixture()
    f.host.ime = FakeIme(ImeCommitResult(success = true, error = null, committedUnits = 3))

    f.controller.requestCommitText(RequestCommitText(requestId = "c1", text = "abc"))
    advanceUntilIdle()

    assertEquals("abc", f.host.ime?.committed)
    assertEquals(1, f.host.forgets)
    val (type, body) = f.sender.frames.single()
    assertEquals("commit_text_result", type)
    assertTrue(body.getValue("success").jsonPrimitive.boolean)
    assertEquals(3, body.getValue("committedUnits").jsonPrimitive.content.toInt())
  }

  @Test
  fun `commit text reports a timeout when the ime service never starts`() = runTest {
    val f = fixture()

    f.controller.requestCommitText(RequestCommitText(requestId = "c2", text = "abc"))
    advanceUntilIdle()

    val body = f.sender.frames.single().second
    assertFalse(body.getValue("success").jsonPrimitive.boolean)
    assertEquals(
      "IME service did not start within timeout",
      body.getValue("error").jsonPrimitive.content,
    )
    assertTrue(f.clock[0] >= 2_000L)
  }

  @Test
  fun `a cancel tombstone stops a later commit with the same request id`() = runTest {
    val f = fixture()
    f.host.ime = FakeIme(ImeCommitResult(success = true, error = null))

    f.controller.requestCancelImeCommit("cancel", "c3")
    advanceUntilIdle()
    f.controller.requestCommitText(RequestCommitText(requestId = "c3", text = "abc"))
    advanceUntilIdle()

    assertNull(f.host.ime?.committed)
    assertEquals("cancel_ime_commit_result", f.sender.frames.first().first)
    val commit = f.sender.frames.last().second
    assertEquals("IME commit cancelled", commit.getValue("error").jsonPrimitive.content)
  }

  @Test
  fun `unknown keyboard profile is rejected without touching the store`() = runTest {
    val f = fixture()

    f.controller.requestSetKeyboardProfile("p1", "nope")
    advanceUntilIdle()

    val result = f.sender.profileResults.single()
    assertFalse(result.success)
    assertTrue(result.error!!.startsWith("Unknown keyboard profile 'nope'"))
    assertEquals(KeyboardProfiles.DEFAULT.id, f.host.store.active)
  }

  @Test
  fun `known keyboard profile persists when no keyboard is live and reports the previous id`() =
    runTest {
      val f = fixture()
      val target = KeyboardProfiles.all.first { it.id != KeyboardProfiles.DEFAULT.id }

      f.controller.requestSetKeyboardProfile("p2", target.id)
      advanceUntilIdle()

      assertEquals(target.id, f.host.store.active)
      val result = f.sender.profileResults.single()
      assertTrue(result.success)
      assertEquals(target.id, result.activeProfileId)
      assertEquals(KeyboardProfiles.DEFAULT.id, result.previousProfileId)
    }

  @Test
  fun `profile catalog lists profiles for a mutually supported version`() = runTest {
    val f = fixture()

    f.controller.requestListKeyboardProfiles(
      "l1",
      KeyboardProfiles.SUPPORTED_CATALOG_VERSIONS,
    )
    advanceUntilIdle()

    val (type, body) = f.sender.frames.single()
    assertEquals("keyboard_profiles_result", type)
    assertTrue(body.getValue("success").jsonPrimitive.boolean)
    assertEquals(KeyboardProfiles.all.size, body.getValue("profiles").jsonArray.size)
  }

  @Test
  fun `profile catalog fails when no catalog version is mutually supported`() = runTest {
    val f = fixture()

    f.controller.requestListKeyboardProfiles("l2", listOf(-1))
    advanceUntilIdle()

    val body = f.sender.frames.single().second
    assertFalse(body.getValue("success").jsonPrimitive.boolean)
    assertTrue(body.getValue("error").jsonPrimitive.content.startsWith("No mutually supported"))
  }
}
