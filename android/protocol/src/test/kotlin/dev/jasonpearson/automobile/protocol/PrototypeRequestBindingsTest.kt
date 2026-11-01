package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * The Kotlin twin of `test/features/prototype/prototypeRequest.test.ts` (#12523): the same
 * validation verdicts, paths and messages, and the same resolution and response semantics.
 */
class PrototypeRequestBindingsTest : PrototypeRequestTestSupport() {
  @Test
  fun `a request round trips through the Kotlin model`() {
    val action =
      """{"type":"request","method":"POST","url":"http://x.test/{q}","headers":{"A":"1","B":{"state":"q"}},""" +
        """"query":{"n":{"value":3}},"body":{"value":{"k":true}},"into":"/data/out","statusKey":"status",""" +
        """"via":"device","timeoutMs":5000,"onSuccess":[{"type":"setState","key":"count","value":1}],""" +
        """"onError":[{"type":"dismiss"}]}"""
    val result = check(action) as PrototypeSpecValidation.Success
    val decoded =
      (result.spec.root as PrototypeButtonNode).onTap!!.single() as PrototypeRequestAction
    assertEquals("POST", decoded.method)
    assertEquals("device", decoded.via)
    assertEquals(5000, decoded.timeoutMs)
    assertEquals(JsonPrimitive("1"), decoded.headers!!.getValue("A"))
    assertEquals(obj("""{"state":"q"}"""), decoded.headers.getValue("B"))
    assertEquals(obj("""{"value":{"k":true}}"""), decoded.body)
    assertEquals(PrototypeDismissAction, decoded.onError!!.single())
  }

  // ---- resolution ----

  @Test
  fun `request text binds data and state in one pass`() {
    val data = obj("""{"prefix":"{token}","id":"7"}""")
    val state = { text: String -> text.replace("{token}", "SECRET").replace("{q}", "query") }
    // A data value that holds {token} is sent as written, never interpolated as state (#14321).
    assertEquals("Bearer {token}", PrototypeRequests.bindText("Bearer {data:/prefix}", data, state))
    // Authored state placeholders around a data placeholder still resolve.
    assertEquals(
      "query/7/SECRET",
      PrototypeRequests.bindText("{q}/{data:/id}/{token}", data, state),
    )
  }

  @Test
  fun `resolves bindings, defaults the method and sets query values on the url`() {
    val request =
      resolved(
        request(
          """"method":"POST","headers":{"A":"lit","B":{"state":"q"},"C":{"data":"/title"},"D":{"value":5}},""" +
            """"query":{"q":{"state":"q"},"n":{"state":"n"},"flag":{"state":"on"},"z":"9"},"body":{"value":{"k":1}}""",
        ),
        "http://localhost:8080/feed?q=old",
      )
    assertEquals("POST", request.method)
    assertEquals("http://localhost:8080/feed?q=cats&flag=true&n=3&z=9", request.url)
    assertEquals(mapOf("A" to "lit", "B" to "cats", "C" to "Feed", "D" to "5"), request.headers)
    assertEquals(obj("""{"k":1}"""), request.body)
    val bare = resolved("""{"type":"request","url":"x"}""", "https://a.test")
    assertEquals("GET", bare.method)
    assertEquals(emptyMap<String, String>(), bare.headers)
    assertEquals("https://a.test/", bare.url)
    assertNull(bare.body)
  }

  @Test
  fun `a url's query keeps its spelling when no query is authored`() {
    assertEquals(
      "http://localhost:8080/feed?flag&x=%20",
      resolved(request(), "http://localhost:8080/feed?flag&x=%20").url,
    )
    assertEquals(
      "http://localhost:8080/feed?",
      resolved(request(), "http://localhost:8080/feed?").url,
    )
  }

  @Test
  fun `an authored query entry is appended to the url's existing query`() {
    // Output of resolvePrototypeRequest for the same url and {b: "2"}.
    assertEquals(
      "http://localhost:8080/feed?a=1&b=2",
      resolved(request(""""query":{"b":"2"}"""), "http://localhost:8080/feed?a=1").url,
    )
  }

  @Test
  fun `a query key already in the url is replaced and a duplicate is dropped`() {
    val url = resolved(request(""""query":{"a":"2"}"""), "http://h.test/p?a=1&b=x%20y&a=3&c").url
    // Only the replaced key is re-encoded; the other pieces keep their spelling.
    assertEquals("http://h.test/p?a=2&b=x%20y&c", url)
  }

  @Test
  fun `authored query entries are set in sorted key order`() {
    assertEquals(
      "http://h.test/p?a=2&z=1",
      resolved(request(""""query":{"z":"1","a":"2"}"""), "http://h.test/p").url,
    )
  }

  @Test
  fun `a body binding reads state and data`() {
    assertEquals(
      obj("""{"a":1}"""),
      resolved(request(""""method":"PUT","body":{"data":"/obj"}"""), "http://a.test").body,
    )
    assertEquals(
      JsonPrimitive("cats"),
      resolved(request(""""method":"PUT","body":{"state":"q"}"""), "http://a.test").body,
    )
  }

  @Test
  fun `bad urls and unresolvable bindings fail with typed codes`() {
    assertEquals(PrototypeRequestErrorCode.INVALID_URL, failed(request(), "ftp://a.test").code)
    assertEquals(PrototypeRequestErrorCode.INVALID_URL, failed(request(), "not a url").code)
    for (json in
      listOf(
        request(""""headers":{"A":{"state":"missing"}}"""),
        request(""""query":{"a":{"data":"/missing"}}"""),
        request(""""query":{"a":{"data":"/obj"}}"""),
        request(""""method":"POST","body":{"state":"missing"}"""),
      )) {
      assertEquals(PrototypeRequestErrorCode.INVALID_REQUEST, failed(json).code, json)
    }
  }

  // ---- response handling ----

  @Test
  fun `meta is a sibling key with the suffix on the last segment`() {
    assertEquals("/data/feed__meta", PrototypeRequests.metaPath("/data/feed"))
    assertEquals("/data/a/b~1c__meta", PrototypeRequests.metaPath("/data/a/b~1c"))
  }

  @Test
  fun `a JSON body is written to into and the metadata beside it`() {
    val result =
      applied(
        """{"title":"T"}""",
        "/data/feed",
        received(Json.parseToJsonElement("""{"items":[1,2]}""")),
      )
    assertTrue(result.result.succeeded)
    assertTrue(result.result.wroteInto)
    assertEquals(
      obj(
        """{"title":"T","feed":{"items":[1,2]},"feed__meta":{"status":200,"headers":{"content-type":"application/json"},"durationMs":12}}""",
      ),
      result.data,
    )
  }

  @Test
  fun `a non-JSON body is a string and an empty body is an empty string`() {
    assertEquals(
      JsonPrimitive("plain text"),
      applied("{}", "/data/t", received(JsonPrimitive("plain text"))).data!!["t"],
    )
    assertEquals(JsonPrimitive(""), applied("{}", "/data/t", received(null, 204)).data!!["t"])
  }

  @Test
  fun `a literal null body is invalid_response and leaves into unchanged`() {
    val result = applied("""{"t":"old"}""", "/data/t", received(JsonNull))
    assertFalse(result.result.succeeded)
    assertFalse(result.result.wroteInto)
    assertEquals(JsonPrimitive("old"), result.data!!["t"])
    assertEquals(PrototypeRequestErrorCode.INVALID_RESPONSE, result.result.meta.error!!.code)
  }

  @Test
  fun `a body that fits without room for the metadata is invalid_response and into stays`() {
    val data = obj("""{"feed":"o"}""")
    var low = 0
    var high = PrototypeSpecValidator.MAX_PROTOTYPE_DATA_WRITE_BYTES
    while (low < high) {
      val mid = (low + high + 1) / 2
      val fits =
        PrototypeDataWriter.apply(
          data,
          PrototypeDataWrite.Set("/data/feed", JsonPrimitive("x".repeat(mid))),
        ) is PrototypeDataWriteResult.Success
      if (fits) low = mid else high = mid - 1
    }

    val result = applied("""{"feed":"o"}""", "/data/feed", received(JsonPrimitive("x".repeat(low))))

    assertFalse(result.result.succeeded)
    assertFalse(result.result.wroteInto)
    assertEquals(JsonPrimitive("o"), result.data!!["feed"])
    val error = result.result.meta.error!!
    assertEquals(PrototypeRequestErrorCode.INVALID_RESPONSE, error.code)
    assertEquals("response and metadata exceed the data limit", error.message)
  }

  @Test
  fun `an empty 2xx body succeeds and writes an empty string`() {
    val result = applied("{}", "/data/t", received(null))
    assertTrue(result.result.succeeded)
    assertEquals(JsonPrimitive(""), result.data!!["t"])
  }

  @Test
  fun `a non-2xx status leaves into alone records http_error and reports error`() {
    val result = applied("""{"feed":"old"}""", "/data/feed", received(obj("""{"e":1}"""), 404))
    assertFalse(result.result.succeeded)
    assertFalse(result.result.wroteInto)
    assertEquals(JsonPrimitive("old"), result.data!!["feed"])
    assertEquals(
      obj(
        """{"status":404,"headers":{"content-type":"application/json"},"durationMs":12,"error":{"code":"http_error","message":"HTTP 404"}}""",
      ),
      result.data["feed__meta"],
    )
  }

  @Test
  fun `blocked destination code round trips and is serialized in metadata`() {
    val code = PrototypeRequestErrorCode.BLOCKED_DESTINATION
    assertEquals("blocked_destination", code.wireValue)
    assertEquals(code, PrototypeRequestErrorCode.fromWire("blocked_destination"))
    val result =
      applied(
        "{}",
        "/data/feed",
        PrototypeRequestResponse.Failed(PrototypeRequestError(code, "Blocked destination")),
      )
    assertEquals(
      JsonPrimitive("blocked_destination"),
      result.data!!["feed__meta"]!!.jsonObject["error"]!!.jsonObject["code"],
    )
  }

  @Test
  fun `a transport failure writes only error metadata`() {
    val failure =
      PrototypeRequestResponse.Failed(
        PrototypeRequestError(
          PrototypeRequestErrorCode.TIMEOUT,
          "Request timed out after 10000ms.",
        ),
        10_000,
      )
    val result = applied("{}", "/data/feed", failure)
    assertFalse(result.result.succeeded)
    assertFalse(result.result.wroteInto)
    assertEquals(
      obj(
        """{"feed__meta":{"durationMs":10000,"error":{"code":"timeout","message":"Request timed out after 10000ms."}}}""",
      ),
      result.data,
    )
  }

  @Test
  fun `a body data cannot hold is an invalid_response error`() {
    val result = applied("{}", "/data/feed", received(obj("""{"a":null}""")))
    assertFalse(result.result.succeeded)
    assertEquals(PrototypeRequestErrorCode.INVALID_RESPONSE, result.result.meta.error?.code)
    assertNull(result.data!!["feed"])
    val meta = result.data["feed__meta"]!!.jsonObject
    assertEquals(JsonPrimitive(200), meta["status"])
    assertEquals(
      JsonPrimitive("invalid_response"),
      meta.getValue("error").jsonObject["code"],
    )
  }

  @Test
  fun `a body over the write limit fails the write and is reported`() {
    val body = JsonPrimitive("x".repeat(PrototypeSpecValidator.MAX_PROTOTYPE_DATA_WRITE_BYTES))
    val result = applied("{}", "/data/feed", received(body))
    assertEquals(PrototypeRequestErrorCode.INVALID_RESPONSE, result.result.meta.error?.code)
    assertFalse(result.result.wroteInto)
  }

  @Test
  fun `without into only the outcome is reported`() {
    val result = applied("""{"a":"b"}""", null, received(obj("""{"x":1}""")))
    assertTrue(result.result.succeeded)
    assertEquals(obj("""{"a":"b"}"""), result.data)
  }

  @Test
  fun `headers are dropped when only they push the metadata past the write limit`() {
    val filler = "y".repeat(PrototypeSpecValidator.MAX_PROTOTYPE_DATA_WRITE_BYTES - 400)
    val response = received(JsonPrimitive("body"), headers = mapOf("x-big" to "z".repeat(1000)))
    val result = applied("""{"pad":"$filler"}""", "/data/feed", response)
    assertEquals(JsonPrimitive("body"), result.data!!["feed"])
    assertEquals(obj("""{"status":200,"durationMs":12}"""), result.data["feed__meta"])
  }
}
