package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * The Kotlin twin of `test/features/prototype/prototypeRequest.test.ts` (#12523): the same
 * validation verdicts, paths and messages, and the same resolution and response semantics.
 */
class PrototypeRequestResponsesTest : PrototypeRequestTestSupport() {
  @Test
  fun `a renderer refusal of the metadata stages nothing and reports invalid_response`() {
    var data: JsonObject? = obj("""{"feed":"old"}""")
    val committed = mutableListOf<PrototypeDataWrite>()
    // Stands in for the runtime's rebuilt-render limits: a success-shaped metadata is refused.
    fun refusedByRenderer(write: PrototypeDataWrite) =
      write.path == "/data/feed__meta" &&
        (write as PrototypeDataWrite.Set).value.let { it is JsonObject && "error" !in it }
    val refusal =
      PrototypeDataWriteError(
        PrototypeDataWriteErrorCode.LIMIT_EXCEEDED,
        "rendered text too long",
      )
    val result =
      PrototypeRequestOutcome.complete(
        "/data/feed",
        received(JsonPrimitive("new")),
        { writes ->
          if (writes.any(::refusedByRenderer)) refusal
          else PrototypeRequestOutcome.dataTrial(data, writes)
        },
      ) { write ->
        committed += write
        when (val written = PrototypeDataWriter.apply(data, write)) {
          is PrototypeDataWriteResult.Success -> {
            data = written.data
            null
          }
          is PrototypeDataWriteResult.Failure -> written.error
        }
      }

    // Neither the speculative body nor a rollback was ever committed (and so never reported).
    assertEquals(listOf("/data/feed__meta"), committed.map { it.path })
    assertFalse(result.succeeded)
    assertFalse(result.wroteInto)
    assertEquals(PrototypeRequestErrorCode.INVALID_RESPONSE, result.meta.error!!.code)
    assertEquals("response and metadata exceed the data limit", result.meta.error.message)
    assertEquals(JsonPrimitive("old"), data!!["feed"])
    assertEquals(
      "invalid_response",
      data["feed__meta"]!!
        .jsonObject
        .getValue("error")
        .jsonObject
        .getValue("code")
        .jsonPrimitive
        .content,
    )
  }

  @Test
  fun `a response body parses like JSON parse and anything else stays text`() {
    assertEquals(
      obj("""{"a":[1,true,null]}"""),
      PrototypeRequests.parseJson("""{"a":[1,true,null]}"""),
    )
    assertEquals(Json.parseToJsonElement("12.5"), PrototypeRequests.parseJson(" 12.5 "))
    assertEquals(Json.parseToJsonElement("true"), PrototypeRequests.parseJson("true"))
    assertEquals(JsonNull, PrototypeRequests.parseJson("null"))
    assertEquals(JsonPrimitive("quoted"), PrototypeRequests.parseJson("\"quoted\""))
    // kotlinx would keep these as unquoted literals; JSON.parse refuses them, so they are text.
    for (text in listOf("OK", "yyyy", "NaN", "Infinity", "True", "1 2", "<b>x</b>", "{oops", "")) {
      assertNull(PrototypeRequests.parseJson(text), text)
    }
  }

  // ---- the event ----

  @Test
  fun `the event payload carries the outcome and an error exactly when it failed`() {
    assertEquals(
      obj(
        """{"requestId":"r-1","method":"GET","url":"http://localhost:8080/feed?q=cats","via":"host","into":"/data/feed","outcome":"success","status":200,"durationMs":31}""",
      ),
      PrototypeRequestEvent.payload(
        "r-1",
        "GET",
        "http://localhost:8080/feed?q=cats",
        "host",
        "/data/feed",
        200,
        31,
        null,
      ),
    )
    val error =
      PrototypeRequestEvent.payload(
        "r-2",
        "POST",
        "u".repeat(3000),
        "device",
        null,
        null,
        5,
        PrototypeRequestError(PrototypeRequestErrorCode.NETWORK, "m".repeat(900)),
      )
    assertEquals("error", (error["outcome"] as JsonPrimitive).content)
    assertEquals(PrototypeRequests.EVENT_URL_MAX, (error["url"] as JsonPrimitive).content.length)
    assertFalse("status" in error)
    assertFalse("into" in error)
    val message = (error.getValue("error").jsonObject["message"] as JsonPrimitive).content
    assertEquals(PrototypeRequests.EVENT_MESSAGE_MAX, message.length)
  }

  @Test
  fun `the limits are the contract limits`() {
    assertEquals(10_000, PrototypeSpecValidator.DEFAULT_PROTOTYPE_REQUEST_TIMEOUT_MS)
    assertEquals(30_000, PrototypeSpecValidator.MAX_PROTOTYPE_REQUEST_TIMEOUT_MS)
    assertEquals(262_144, PrototypeSpecValidator.MAX_PROTOTYPE_RESPONSE_BYTES)
    assertEquals(4, PrototypeSpecValidator.MAX_PROTOTYPE_REQUESTS_IN_FLIGHT)
    assertEquals(4, PrototypeSpecValidator.MAX_PROTOTYPE_ACTION_DEPTH)
    assertTrue(
      PrototypeSpecValidator.MAX_PROTOTYPE_RESPONSE_BYTES <=
        PrototypeSpecValidator.MAX_PROTOTYPE_DATA_WRITE_BYTES,
    )
  }
}
