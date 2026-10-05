package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.SdkAnrEvent
import dev.jasonpearson.automobile.protocol.SdkEventBatchBroadcastContract
import dev.jasonpearson.automobile.protocol.SdkEventSerializer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Test

class SdkAnrBroadcastHandlerTest {
  @Test
  fun `ordered ANR acknowledges after downstream handoff`() {
    val result = FakeResult(true)
    val fixture = Fixture(beforeEnqueue = { assertTrue(result.codes.isEmpty()) })
    fixture.handler.handle(json, result, "id")
    assertEquals(listOf(event), fixture.events)
    assertEquals(listOf(SdkEventBatchBroadcastContract.RESULT_BATCH_ACCEPTED), result.codes)
  }

  @Test
  fun `non ordered legacy ANR forwards without setting result`() {
    val fixture = Fixture()
    val result = FakeResult(false)
    fixture.handler.handle(json, result)
    assertEquals(listOf(event), fixture.events)
    assertTrue(result.codes.isEmpty())
  }

  @Test
  fun `missing malformed and wrong type payloads reject without forwarding`() {
    val fixture = Fixture()
    val result = FakeResult(true)
    for (invalid in listOf(null, "not-json", "{}", "{\"type\":\"event_batch\"}")) {
      fixture.handler.handle(invalid, result, "id")
    }
    assertTrue(fixture.events.isEmpty())
    assertEquals(
      List(4) { SdkEventBatchBroadcastContract.RESULT_BATCH_REJECTED_INVALID_PAYLOAD },
      result.codes,
    )
    fixture.handler.handle(json, result, "id")
    assertEquals(listOf(event), fixture.events)
  }

  @Test
  fun `invalid non ordered payload never sets result`() {
    val fixture = Fixture()
    val result = FakeResult(false)
    fixture.handler.handle(null, result)
    assertTrue(fixture.events.isEmpty())
    assertTrue(result.codes.isEmpty())
  }

  @Test
  fun `replayed delivery id acknowledges twice and forwards once`() {
    val fixture = Fixture()
    val result = FakeResult(true)
    repeat(2) { fixture.handler.handle(json, result, "same") }
    assertEquals(listOf(event), fixture.events)
    assertEquals(List(2) { SdkEventBatchBroadcastContract.RESULT_BATCH_ACCEPTED }, result.codes)
  }

  @Test
  fun `deduplication is bounded and repeats do not refresh oldest id`() {
    val fixture = Fixture(capacity = 2)
    val result = FakeResult(true)
    for (id in listOf("oldest", "second", "oldest", "third", "oldest")) {
      fixture.handler.handle(json, result, id)
    }
    assertEquals(List(4) { event }, fixture.events)
    assertEquals(List(5) { SdkEventBatchBroadcastContract.RESULT_BATCH_ACCEPTED }, result.codes)
  }

  @Test
  fun `absent delivery id preserves legacy repeated forwarding`() {
    val fixture = Fixture()
    val result = FakeResult(false)
    repeat(2) { fixture.handler.handle(json, result) }
    assertEquals(List(2) { event }, fixture.events)
    assertTrue(result.codes.isEmpty())
  }

  @Test
  fun `failed handoff does not remember delivery id`() {
    var accept = false
    val fixture = Fixture(accept = { accept })
    val result = FakeResult(true)
    fixture.handler.handle(json, result, "retry")
    accept = true
    repeat(2) { fixture.handler.handle(json, result, "retry") }
    assertEquals(List(2) { event }, fixture.events)
    assertEquals(listOf(1001, 1000, 1000), result.codes)
  }

  @Test
  fun `invalid replay is rejected even after id was accepted`() {
    val fixture = Fixture()
    val result = FakeResult(true)
    fixture.handler.handle(json, result, "id")
    fixture.handler.handle("not-json", result, "id")
    fixture.handler.handle(json, result, "id")
    assertEquals(listOf(event), fixture.events)
    assertEquals(listOf(1000, 1002, 1000), result.codes)
  }

  private class Fixture(
    capacity: Int = 256,
    accept: () -> Boolean = { true },
    beforeEnqueue: () -> Unit = {},
  ) {
    val events = mutableListOf<SdkAnrEvent>()
    val handler =
      SdkAnrBroadcastHandler(
        enqueue = { event ->
          events.add(event)
          beforeEnqueue()
          accept()
        },
        log =
          object : SdkEventBatchBroadcastHandler.LogSink {
            override fun debug(message: String) {}

            override fun warn(message: String) {
              error(message)
            }
          },
        recentAnrCapacity = capacity,
      )
  }

  private class FakeResult(override val isOrdered: Boolean) :
    SdkEventBatchBroadcastHandler.ResultSink {
    val codes = mutableListOf<Int>()

    override fun setResultCode(code: Int) {
      check(isOrdered)
      codes.add(code)
    }
  }

  private companion object {
    val event =
      SdkAnrEvent(
        timestamp = 20L,
        applicationId = "app",
        pid = 123,
        processName = "app",
        importance = "FOREGROUND",
        trace = null,
        reason = "Application Not Responding",
      )
    val json = SdkEventSerializer.toJson(event)

    @BeforeClass
    @JvmStatic
    fun warmSerializer() {
      SdkEventSerializer.anrEventFromJson(json)
    }
  }
}
