@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package dev.jasonpearson.automobile.prototype.appshell

import dev.jasonpearson.automobile.protocol.PrototypeEvent
import dev.jasonpearson.automobile.protocol.PrototypeEventKind
import dev.jasonpearson.automobile.protocol.PrototypeResult
import java.io.IOException
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
    var readLimit: Int? = null

    override suspend fun readLine(maxBytes: Int): String? {
      readLimit = maxBytes
      return input.receiveCatching().getOrNull()
    }

    override suspend fun write(line: String) {
      if (written.size == failAt) throw IOException("fake send failure")
      written += attachJson.parseToJsonElement(line).jsonObject
    }

    override fun close() {
      closed = true
      input.close()
    }

    fun send(line: String) {
      input.trySend(line).getOrThrow()
    }

    fun hello(token: String = "secret") = send("""{"type":"hello","token":"$token"}""")
  }

  private class Target : AttachTarget {
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
        put("protocolVersion", 1)
        put(
          "capabilities",
          JsonArray(
            listOf(
                "get_prototype_status",
                "patch_prototype",
                "prototype_patch_v1",
                "prototype_inspect_v1",
                "prototype_persistence_replay_v1",
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
    assertEquals(206L, connection.written.last().getValue("sequence").jsonPrimitive.long)
    connection.send("""{"type":"get_prototype_status","requestId":"status"}""")
    runCurrent()
    val result = connection.written.last()
    assertEquals("prototype_result", result.getValue("type").jsonPrimitive.content)
    assertEquals("status", result.getValue("requestId").jsonPrimitive.content)
    assertEquals(
      5L,
      result.getValue("status").jsonObject.getValue("droppedEvents").jsonPrimitive.long,
    )
  }

  @Test
  fun `reconnect replays held events and authenticated replacement closes the old peer`() =
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
      assertTrue(second.closed)
      assertFalse(third.closed)
      agent.emit(event(4))
      assertEquals(4L, third.written.last().getValue("sequence").jsonPrimitive.long)
    }

  @Test
  fun `failed replay restores failed event and tail before newer live events`() = runTest {
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
      listOf(2L, 3L, 4L),
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
}
