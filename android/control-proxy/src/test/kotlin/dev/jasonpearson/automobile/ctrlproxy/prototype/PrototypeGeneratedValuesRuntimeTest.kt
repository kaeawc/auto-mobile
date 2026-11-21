package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import java.io.File
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class PrototypeGeneratedValuesRuntimeTest {
  private class SeededIds : PrototypeIdGenerator {
    var count = 0

    override fun next(): String = "id-${++count}"
  }

  private class FixedClock : dev.jasonpearson.automobile.protocol.PrototypeClock {
    override fun nowEpochMs(): Long = 1700000000000
  }

  @Test fun `generated data and time`() = runFixture(0)

  @Test fun `request success captures dispatch id`() = runFixture(1)

  @Test fun `request error captures dispatch id`() = runFixture(2)

  @Test fun `request writes keyed member`() = runFixture(3)

  private fun fixtureSpec(fixture: JsonObject): PrototypeSpec {
    val text = buildJsonObject {
      put("id", "generated")
      put(
        "window",
        buildJsonObject { put("placement", buildJsonObject { put("type", "fullscreen") }) },
      )
      put("data", fixture.getValue("initialData"))
      put(
        "root",
        buildJsonObject {
          put("type", "button")
          put("label", "Go")
          put("onTap", fixture.getValue("actions"))
        },
      )
    }
      .toString()
    val validation = PrototypeSpecValidator.validate(text)
    return (validation as? PrototypeSpecValidation.Success)?.spec ?: error(validation.toString())
  }

  private fun runFixture(index: Int) = runTest {
    val fixture = cases[index].jsonObject
    val name = fixture.getValue("name").jsonPrimitive.content
    val spec = fixtureSpec(fixture)
    val events = mutableListOf<PrototypeEvent>()
    val requests = mutableListOf<PrototypeHttpRequest>()
    val answers = mutableListOf<CompletableDeferred<PrototypeRequestResponse>>()
    val client = PrototypeHttpClient { request ->
      requests += request
      CompletableDeferred<PrototypeRequestResponse>().also { answers += it }.await()
    }
    val ids = SeededIds()
    var sequence = 0L
    val warnings = mutableListOf<String>()
    val runtime =
      PrototypeRuntime(
        spec,
        PrototypeEventSink { events += it },
        { 0L },
        { ++sequence },
        warn = { warnings += it },
        httpClients = PrototypeHttpClients(client, client),
        requestScope = backgroundScope,
        idGenerator = ids,
        generatedClock = FixedClock(),
      )
    runtime.handle(PrototypeInteraction.Tap((spec.root as PrototypeButtonNode).onTap!!))
    runCurrent()
    completeResponses(fixture, requests, answers)
    runCurrent()
    assertEquals(name, fixture.getValue("expected").jsonObject["data"], runtime.current.spec.data)
    assertTrue("$name: $warnings", warnings.isEmpty())
    val expectedCount =
      if (name.contains("captures")) 2 else if (name.startsWith("generated")) 1 else 0
    assertEquals(name, expectedCount, ids.count)
    assertEquals(
      name,
      runtime.current.spec.data,
      mirror(events, fixture.getValue("initialData").jsonObject),
    )
  }

  private fun completeResponses(
    fixture: JsonObject,
    requests: List<PrototypeHttpRequest>,
    answers: List<CompletableDeferred<PrototypeRequestResponse>>,
  ) {
    val name = fixture.getValue("name").jsonPrimitive.content
    for ((responseIndex, response) in fixture.getValue("mockResponses").jsonArray.withIndex()) {
      val body = response.jsonObject
      if (name.contains("captures"))
        assertEquals(name, JsonPrimitive("id-1"), requests[responseIndex].body)
      answers[responseIndex].complete(
        PrototypeRequestResponse.Received(
          body.getValue("status").jsonPrimitive.int,
          emptyMap(),
          body["body"],
          0,
        ),
      )
    }
  }

  /** Replay actual event values and selectors; the host must never generate a second value. */
  private fun mirror(events: List<PrototypeEvent>, initial: JsonObject): JsonObject {
    var data = initial
    for (event in
      events.filter {
        it.kind == PrototypeEventKind.CHANGE && it.name?.startsWith("/data/") == true
      }) {
      val payload = checkNotNull(event.payload).jsonObject
      val value = payload.getValue("value")
      assertTrue(PrototypeGeneratedValues.forms(buildJsonObject { put("value", value) }).isEmpty())
      val selector =
        (payload["where"] as? JsonObject)?.let {
          PrototypeDataMatch(it.getValue("field").jsonPrimitive.content, it.getValue("equals"))
        }
      val write =
        when (payload.getValue("op").jsonPrimitive.content) {
          "append" -> PrototypeDataWrite.Append(checkNotNull(event.name), value)
          else ->
            PrototypeDataWrite.Set(
              checkNotNull(event.name),
              value,
              selector,
              payload["member"]?.jsonPrimitive?.content,
            )
        }
      data = (PrototypeDataWriter.apply(data, write) as PrototypeDataWriteResult.Success).data
    }
    return data
  }

  @Test
  fun `generated setState resolves at execution without consuming ids in planning`() = runTest {
    val text =
      """{"id":"state","window":{"placement":{"type":"fullscreen"}},"root":{"type":"button","label":"Go","onTap":[{"type":"setState","key":"id","value":{"generate":"id"}},{"type":"setState","key":"copy","value":{"lastGenerated":true}},{"type":"setState","key":"at","value":{"now":"iso"}}]}}"""
    val spec = (PrototypeSpecValidator.validate(text) as PrototypeSpecValidation.Success).spec
    val ids = SeededIds()
    val runtime =
      PrototypeRuntime(
        spec,
        nextSequence = { 1L },
        warn = {},
        idGenerator = ids,
        generatedClock = FixedClock(),
      )
    runtime.handle(PrototypeInteraction.Tap((spec.root as PrototypeButtonNode).onTap!!))
    assertEquals(PrototypeScalar.Text("id-1"), runtime.current.state["id"])
    assertEquals(PrototypeScalar.Text("id-1"), runtime.current.state["copy"])
    assertEquals(PrototypeScalar.Text("2023-11-14T22:13:20.000Z"), runtime.current.state["at"])
    assertEquals(1, ids.count)
  }

  companion object {
    private val cases: JsonArray by lazy {
      val file =
        generateSequence(File(System.getProperty("user.dir") ?: ".").absoluteFile) { it.parentFile }
          .map { File(it, "test/fixtures/prototype-spec/data/generated-values.json") }
          .first { it.isFile }
      Json.parseToJsonElement(file.readText()).jsonArray
    }

    @BeforeClass
    @JvmStatic
    fun warmModels() {
      PrototypeSpecValidator.validate("{}")
      cases.size
    }
  }
}
