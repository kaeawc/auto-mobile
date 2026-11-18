@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package dev.jasonpearson.automobile.prototype.appshell

import dev.jasonpearson.automobile.protocol.PrototypeEvent
import dev.jasonpearson.automobile.protocol.PrototypeEventKind
import dev.jasonpearson.automobile.protocol.PrototypeResult
import java.io.IOException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class AppAttachAgentTest {
  private class Connection : AttachConnection {
    val input = Channel<String>(Channel.UNLIMITED)
    val written = mutableListOf<JsonObject>()
    var closed = false
    var failAt: Int? = null
    var blockAt: Int? = null
    val unblock = CompletableDeferred<Unit>()
    var readLimit: Int? = null

    override suspend fun readLine(maxBytes: Int): String? {
      readLimit = maxBytes
      return input.receiveCatching().getOrNull()
    }

    override suspend fun write(line: String) {
      if (written.size == blockAt) unblock.await()
      if (written.size == failAt) throw IOException("fake send failure")
      written += attachJson.parseToJsonElement(line).jsonObject
    }

    override fun close() {
      closed = true
      unblock.complete(Unit)
      input.close()
    }

    fun send(line: String) {
      input.trySend(line).getOrThrow()
    }

    fun hello(token: String = "secret", acknowledged: Long = 0) =
      send(
        """{"type":"hello","token":"$token","lastAcknowledgedSequence":$acknowledged,"appInstanceId":"test-instance"}""",
      )
  }

  private class Target : AttachTarget {
    override val appInstanceId = "test-instance"
    val patches = mutableListOf<Triple<String, Long?, JsonArray>>()
    var reply = PrototypeResult(0, success = true, revision = 7)

    override suspend fun patch(id: String, baseRevision: Long?, ops: JsonArray): PrototypeResult {
      patches += Triple(id, baseRevision, ops)
      return reply
    }

    override suspend fun status() = buildJsonObject {
      put("shown", false)
      put("id", JsonNull)
      put("state", JsonObject(emptyMap()))
      put("lastSequence", 0)
    }
  }

  private fun TestScope.agent(token: String? = "secret", target: AttachTarget = Target()) =
    AppAttachAgent(token, target, backgroundScope, clock = { testScheduler.currentTime }, log = {})

  private fun event(sequence: Long) =
    PrototypeEvent(0, "panel", sequence, PrototypeEventKind.EMIT, null, null, emptyMap())

  @Test
  fun `activity rebinding retains listener identity sequences and unacknowledged events`() =
    runTest {
      var listenerStarts = 0
      val process =
        AppAttachProcess(
          "secret",
          backgroundScope,
          appInstanceId = "test-instance",
          clock = { 0L },
          log = {},
          startListener = { listenerStarts++ },
        )
      val detachFirst = process.bind(Target())
      val first = Connection().also { it.hello() }
      backgroundScope.launch { process.agent.serve(first) }
      runCurrent()
      process.agent.emit(event(process.nextSequence()))
      runCurrent()
      detachFirst()
      val detachReplacement = process.bind(Target())
      // A late old-Activity teardown must not detach the replacement's target.
      detachFirst()
      first.send("""{"type":"patch_prototype","requestId":"new-ui","id":"panel","ops":[]}""")
      runCurrent()
      assertTrue(first.written.last().getValue("success").jsonPrimitive.boolean)
      assertFalse(first.closed)
      first.close()
      runCurrent()
      process.agent.emit(event(process.nextSequence()))
      val second = Connection().also { it.hello() }
      backgroundScope.launch { process.agent.serve(second) }
      runCurrent()
      assertEquals("test-instance", second.written.first()["appInstanceId"]?.jsonPrimitive?.content)
      assertEquals(
        listOf(1L, 2L),
        second.written.drop(1).map { it.getValue("sequence").jsonPrimitive.long },
      )
      second.send("""{"type":"ack","sequence":2,"appInstanceId":"test-instance"}""")
      runCurrent()
      second.close()
      runCurrent()
      val third = Connection().also { it.hello() }
      backgroundScope.launch { process.agent.serve(third) }
      runCurrent()
      assertEquals(1, third.written.size)
      assertEquals(1, listenerStarts)
      detachReplacement()
      third.send("""{"type":"patch_prototype","requestId":"detached-ui","id":"panel","ops":[]}""")
      runCurrent()
      val detachedReply = third.written.last()
      assertEquals("detached-ui", detachedReply.getValue("requestId").jsonPrimitive.content)
      assertFalse(detachedReply.getValue("success").jsonPrimitive.boolean)
      assertEquals(
        "Prototype Activity is not attached",
        detachedReply.getValue("error").jsonPrimitive.content,
      )
      val relaunched =
        AppAttachProcess("secret", backgroundScope, appInstanceId = "new-process", log = {})
      assertNotEquals(process.appInstanceId, relaunched.appInstanceId)
      assertEquals(1L, relaunched.nextSequence())
    }

  @Test
  fun `old app instance hello and ack cannot discard new process replay`() = runTest {
    val agent = agent()
    agent.emit(event(1))
    val first =
      Connection().also {
        it.send(
          """{"type":"hello","token":"secret","appInstanceId":"old-process","lastAcknowledgedSequence":10}""",
        )
      }
    backgroundScope.launch { agent.serve(first) }
    runCurrent()
    assertEquals(
      "test-instance",
      first.written.firstOrNull()?.get("appInstanceId")?.jsonPrimitive?.content,
    )
    assertEquals(listOf(1L), first.written.mapNotNull { it["sequence"]?.jsonPrimitive?.longOrNull })
    first.send("""{"type":"ack","appInstanceId":"old-process","sequence":1}""")
    runCurrent()
    first.close()
    runCurrent()
    val next = Connection().also { it.hello() }
    backgroundScope.launch { agent.serve(next) }
    runCurrent()
    assertEquals(listOf(1L), next.written.mapNotNull { it["sequence"]?.jsonPrimitive?.longOrNull })
  }

  @Test
  fun `invalid first frames write nothing and close`() = runTest {
    val agent = agent()
    for (line in
      listOf(
        """{"type":"hello","token":"wrong"}""",
        """{"type":"get_prototype_status","requestId":"r"}""",
        """{"type":"hello","token":"${"x".repeat(4097)}"}""",
        """{"type":"hello","token":"${"é".repeat(2100)}"}""",
        "not json",
      )) {
      val connection = Connection()
      connection.send(line)
      agent.serve(connection)
      assertTrue(connection.closed)
      assertTrue(connection.written.isEmpty())
      assertEquals(4096, connection.readLimit)
    }
  }

  @Test
  fun `hello deadline closes a silent connection at five seconds`() = runTest {
    val agent = agent()
    val connection = Connection()
    val job = backgroundScope.launch { agent.serve(connection) }
    runCurrent()
    advanceTimeBy(4999)
    runCurrent()
    assertFalse(connection.closed)
    advanceTimeBy(1)
    runCurrent()
    assertTrue(connection.closed)
    assertTrue(connection.written.isEmpty())
    assertTrue(job.isCompleted)
  }

  @Test
  fun `absent and blank tokens disable agent and refuse every connection`() = runTest {
    for (token in listOf(null, "", " \n\t")) {
      val agent = agent(token)
      assertFalse(agent.enabled)
      assertNull(AppAttachServer.start("unused", agent, backgroundScope))
      val connection = Connection().also { it.hello() }
      agent.serve(connection)
      assertTrue(connection.closed)
      assertTrue(connection.written.isEmpty())
      assertNull(connection.readLimit)
    }
  }

  @Test
  fun `hello capabilities are exact and token text is trimmed`() = runTest {
    val agent = agent(" secret\n")
    val connection =
      Connection().also {
        it.hello()
        it.input.close()
      }
    agent.serve(connection)
    assertEquals(
      buildJsonObject {
        put("type", "hello_result")
        put("agentVersion", "0.1.0")
        put("appInstanceId", "test-instance")
        put("protocolVersion", 1)
        put("droppedEvents", 0)
        put(
          "capabilities",
          JsonArray(
            listOf(
                "get_prototype_status",
                "patch_prototype",
                "prototype_patch_v1",
                "prototype_inspect_v1",
                "prototype_persistence_replay_v1",
                "prototype_event_ack_v1",
              )
              .map(::JsonPrimitive),
          ),
        )
      },
      connection.written.single(),
    )
  }

  @Test
  fun `offline overflow replays oldest first before live delivery and reports drops`() = runTest {
    val agent = agent()
    repeat(205) { agent.emit(event(it + 1L)) }
    val connection = Connection().also { it.hello() }
    backgroundScope.launch { agent.serve(connection) }
    runCurrent()
    assertEquals("hello_result", connection.written.first()["type"]?.jsonPrimitive?.content)
    assertEquals(
      (6L..205L).toList(),
      connection.written.drop(1).map { it.getValue("sequence").jsonPrimitive.long },
    )
    agent.emit(event(206))
    runCurrent()
    assertEquals(206L, connection.written.last().getValue("sequence").jsonPrimitive.long)
    connection.send("""{"type":"get_prototype_status","requestId":"status"}""")
    runCurrent()
    val result = connection.written.last()
    assertEquals("prototype_result", result.getValue("type").jsonPrimitive.content)
    assertEquals("status", result.getValue("requestId").jsonPrimitive.content)
    assertEquals(
      6L,
      result.getValue("status").jsonObject.getValue("droppedEvents").jsonPrimitive.long,
    )
  }

  @Test
  fun `reconnect replays held events and authenticated newcomer cannot replace the incumbent`() =
    runTest {
      val agent = agent()
      val first = Connection().also { it.hello() }
      backgroundScope.launch { agent.serve(first) }
      runCurrent()
      val stranger = Connection().also { it.hello("wrong") }
      agent.serve(stranger)
      assertFalse(first.closed)
      first.input.close()
      runCurrent()
      repeat(3) { agent.emit(event(it + 1L)) }
      val second = Connection().also { it.hello() }
      backgroundScope.launch { agent.serve(second) }
      runCurrent()
      assertEquals(
        listOf(1L, 2L, 3L),
        second.written.drop(1).map { it.getValue("sequence").jsonPrimitive.long },
      )
      val third = Connection().also { it.hello() }
      backgroundScope.launch { agent.serve(third) }
      runCurrent()
      assertFalse(second.closed)
      assertTrue(third.closed)
      agent.emit(event(4))
      runCurrent()
      assertEquals(4L, second.written.last().getValue("sequence").jsonPrimitive.long)
    }

  @Test
  fun `failed replay retains even successful writes until host acknowledgement`() = runTest {
    val agent = agent()
    repeat(3) { agent.emit(event(it + 1L)) }
    val first =
      Connection().also {
        it.failAt = 2
        it.hello()
      }
    agent.serve(first)
    assertTrue(first.closed)
    agent.emit(event(4))
    val next =
      Connection().also {
        it.hello()
        it.input.close()
      }
    agent.serve(next)
    assertEquals(
      listOf(1L, 2L, 3L, 4L),
      next.written.drop(1).map { it.getValue("sequence").jsonPrimitive.long },
    )
  }

  @Test
  fun `failed live delivery is replayed on reconnect`() = runTest {
    val agent = agent()
    val first =
      Connection().also {
        it.hello()
        it.failAt = 1
      }
    backgroundScope.launch { agent.serve(first) }
    runCurrent()
    agent.emit(event(1))
    runCurrent()
    assertTrue(first.closed)
    val next =
      Connection().also {
        it.hello()
        it.input.close()
      }
    agent.serve(next)
    assertEquals(1L, next.written.last().getValue("sequence").jsonPrimitive.long)
  }

  @Test
  fun `patch routes id revision and ops and unsupported requests are correlated`() = runTest {
    val target = Target()
    val agent = agent(target = target)
    val connection =
      Connection().also {
        it.hello()
        it.send(
          """{"type":"patch_prototype","requestId":"patch","id":"panel","baseRevision":3,"ops":[{"op":"replace","path":"/state/title","value":"hi"}]}""",
        )
        it.send("""{"type":"other","requestId":"other-id"}""")
        it.input.close()
      }
    agent.serve(connection)
    assertEquals("panel", target.patches.single().first)
    assertEquals(3L, target.patches.single().second)
    assertEquals(
      "/state/title",
      target.patches.single().third.single().jsonObject.getValue("path").jsonPrimitive.content,
    )
    assertEquals("patch", connection.written[1].getValue("requestId").jsonPrimitive.content)
    assertEquals(7L, connection.written[1].getValue("revision").jsonPrimitive.long)
    assertEquals(
      "unsupported request: other",
      connection.written[2].getValue("error").jsonPrimitive.content,
    )
    assertEquals("other-id", connection.written[2].getValue("requestId").jsonPrimitive.content)
    assertFalse(connection.written[2].getValue("success").jsonPrimitive.boolean)
  }

  @Test
  fun `successful write followed by detach replays until hello ack trims`() = runTest {
    val agent = agent()
    val first = Connection().also { it.hello() }
    backgroundScope.launch { agent.serve(first) }
    runCurrent()
    agent.emit(event(1))
    agent.emit(event(2))
    runCurrent()
    assertEquals(3, first.written.size)
    first.close() // adbd accepted the bytes, but the host never acknowledged them.
    runCurrent()
    val second = Connection().also { it.hello() }
    backgroundScope.launch { agent.serve(second) }
    runCurrent()
    assertEquals(
      listOf(1L, 2L),
      second.written.drop(1).map { it.getValue("sequence").jsonPrimitive.long },
    )
    second.close()
    runCurrent()
    val third = Connection().also { it.hello(acknowledged = 1) }
    backgroundScope.launch { agent.serve(third) }
    runCurrent()
    assertEquals(2L, third.written.last().getValue("sequence").jsonPrimitive.long)
    third.send("""{"type":"ack","sequence":2,"appInstanceId":"test-instance"}""")
    runCurrent()
    third.close()
    runCurrent()
    val fourth = Connection().also { it.hello() }
    backgroundScope.launch { agent.serve(fourth) }
    runCurrent()
    assertEquals(1, fourth.written.size)
  }

  @Test
  fun `blocked writer does not block emit or patch and timeout releases the peer`() = runTest {
    val target = Target()
    val agent = agent(target = target)
    val first =
      Connection().also {
        it.hello()
        it.blockAt = 1
      }
    backgroundScope.launch { agent.serve(first) }
    runCurrent()
    agent.emit(event(1))
    runCurrent()
    first.send("""{"type":"patch_prototype","requestId":"r","id":"panel","ops":[]}""")
    runCurrent()
    assertEquals(1, target.patches.size)
    assertFalse(first.closed)
    advanceTimeBy(AppAttachAgent.WRITE_TIMEOUT_MS)
    runCurrent()
    assertTrue(first.closed)
    val next = Connection().also { it.hello() }
    backgroundScope.launch { agent.serve(next) }
    runCurrent()
    assertEquals(1L, next.written.last().getValue("sequence").jsonPrimitive.long)
  }

  @Test
  fun `bounded outbound queue drops a nonreading peer without stalling producers`() = runTest {
    val agent = agent()
    val connection =
      Connection().also {
        it.hello()
        it.blockAt = 1
      }
    backgroundScope.launch { agent.serve(connection) }
    runCurrent()
    agent.emit(event(1))
    runCurrent()
    repeat(AppAttachAgent.OUTBOUND_CAPACITY + 1) { agent.emit(event(it + 2L)) }
    assertTrue(connection.closed)
    runCurrent()
    val next = Connection().also { it.hello() }
    backgroundScope.launch { agent.serve(next) }
    runCurrent()
    assertEquals(200, next.written.size - 1)
    assertEquals(58L, next.written.first().getValue("droppedEvents").jsonPrimitive.long)
  }

  @Test
  fun `physical devices need explicit opt in and emulator policy uses an injectable fake`() =
    runTest {
      val emulator = AttachDeviceEnvironment { true }
      val physical = AttachDeviceEnvironment { false }
      assertTrue(AttachDevicePolicy(emulator).allowsListener())
      assertFalse(AttachDevicePolicy(physical).allowsListener())
      assertNull(
        AppAttachServer.start(
          "unused",
          agent(),
          backgroundScope,
          policy = AttachDevicePolicy(physical),
        ),
      )
      assertTrue(AttachDevicePolicy(physical, allowPhysicalDevice = true).allowsListener())
    }
}
