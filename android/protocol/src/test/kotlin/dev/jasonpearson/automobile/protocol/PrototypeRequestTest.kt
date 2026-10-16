package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test

/**
 * The Kotlin twin of `test/features/prototype/prototypeRequest.test.ts` (#12523): the same
 * validation verdicts, paths and messages, and the same resolution and response semantics.
 */
class PrototypeRequestTest {
  companion object {
    @JvmStatic
    @BeforeAll
    fun warmValidator() {
      PrototypeSpecValidator.validate("{}")
    }
  }

  private fun obj(text: String): JsonObject = Json.parseToJsonElement(text).jsonObject

  private fun request(extra: String = ""): String =
    """{"type":"request","url":"http://localhost:8080/feed","into":"/data/feed"${
      if (extra.isEmpty()) "" else ",$extra"
    }}"""

  private fun spec(
    actions: String,
    state: String = """{"status":"idle","count":0,"flag":false,"q":"a"}""",
  ) =
    """{"id":"req","window":{"placement":{"type":"fullscreen"}},"state":$state,"data":{"title":"T"},"root":{"type":"button","label":"Go","onTap":[$actions]}}"""

  private fun check(action: String, state: String? = null): PrototypeSpecValidation =
    PrototypeSpecValidator.validate(if (state == null) spec(action) else spec(action, state))

  private fun failure(action: String): PrototypeSpecError? =
    (check(action) as? PrototypeSpecValidation.Failure)?.error

  private fun assertValid(action: String) = assertNull(failure(action), action)

  // ---- validation ----

  @Test
  fun `accepts the full action and the defaults`() {
    assertValid(request())
    assertValid("""{"type":"request","url":"https://example.com"}""")
    assertValid(
      request(
        """"method":"POST","headers":{"Accept":"application/json","X-Q":{"state":"q"},"X-T":{"data":"/title"}},""" +
          """"query":{"q":{"state":"q"},"n":{"value":3},"lit":"x"},"body":{"state":"q"},""" +
          """"statusKey":"status","via":"device","timeoutMs":30000,""" +
          """"onSuccess":[{"type":"setState","key":"count","value":1}],""" +
          """"onError":[{"type":"toggle","key":"flag"}]""",
      ),
    )
  }

  @Test
  fun `a templated url binds after the scheme and any host is allowed`() {
    for (url in
      listOf(
        "http://{q}/feed",
        "https://localhost:{count}/{data:/title}",
        "http://192.168.1.4/x?{q}=1",
        "http://localhost/",
        "http://127.0.0.1:9/",
        "http://[::1]/",
        "http://10.0.2.2:8080/",
        "http://169.254.169.254/",
      )) {
      assertValid(request().replace("http://localhost:8080/feed", url))
    }
    assertEquals(
      PrototypeSpecError(
        "root.onTap[0].url",
        "A templated request url must start with a literal http:// or https://",
      ),
      failure(request().replace("http://localhost:8080/feed", "{q}://x")),
    )
    for (url in listOf("ftp://example.com", "example.com", "http://", "mailto:a@b")) {
      assertEquals(
        PrototypeSpecError(
          "root.onTap[0].url",
          "A request url must be an absolute http or https URL",
        ),
        failure(request().replace("http://localhost:8080/feed", url)),
        url,
      )
    }
  }

  @Test
  fun `statusKey must be a declared string state key`() {
    assertValid(request(""""statusKey":"status""""))
    assertEquals(
      PrototypeSpecError("root.onTap[0].statusKey", "statusKey must name a declared state key"),
      failure(request(""""statusKey":"missing"""")),
    )
    for (key in listOf("count", "flag")) {
      assertEquals(
        PrototypeSpecError("root.onTap[0].statusKey", "statusKey requires a string state key"),
        failure(request(""""statusKey":"$key"""")),
      )
    }
  }

  @Test
  fun `into is a data member that is not an array element`() {
    val pointerMessage = "request into is /data/<RFC 6901 pointer> and addresses a member of data"
    for (into in listOf("/feed", "/state/feed", "/data")) {
      assertEquals(
        PrototypeSpecError("root.onTap[0].into", pointerMessage),
        failure(request().replace("/data/feed", into)),
        into,
      )
    }
    assertEquals(
      PrototypeSpecError(
        "root.onTap[0].into",
        "request into must name an object member, not an array element, so into__meta can be written beside it",
      ),
      failure(request().replace("/data/feed", "/data/feed/0")),
    )
    assertValid("""{"type":"request","url":"http://x.test/","method":"POST"}""")
    assertValid(request().replace("/data/feed", "/data/a/b/c"))
  }

  @Test
  fun `a body is refused on GET, HEAD and an omitted method`() {
    for (method in listOf("\"GET\"", "\"HEAD\"", null)) {
      val extra = (method?.let { "\"method\":$it," } ?: "") + """"body":{"value":1}"""
      assertEquals(
        PrototypeSpecError("root.onTap[0].body", "A GET or HEAD request cannot have a body"),
        failure(request(extra)),
      )
    }
  }

  @Test
  fun `header and query bindings take every binding form and reject objects`() {
    assertValid(request(""""headers":{"A":{"state":"q"},"B":{"data":"/title"},"C":{"value":1}}"""))
    assertEquals(
      PrototypeSpecError(
        "root.onTap[0].headers.A.value",
        "A header or query literal must be a string, number or boolean",
      ),
      failure(request(""""headers":{"A":{"value":{"nested":1}}}""")),
    )
    assertEquals(
      "root.onTap[0].query.a.value",
      failure(request(""""query":{"a":{"value":[1]}}"""))?.path,
    )
    assertEquals(
      PrototypeSpecError("root.onTap[0].headers[\"bad name\"]", "Invalid header name"),
      failure(request(""""headers":{"bad name":"x"}""")),
    )
    assertEquals(
      "root.onTap[0].query.a.bogus",
      failure(request(""""query":{"a":{"bogus":1}}"""))?.path,
    )
    assertEquals(
      "root.onTap[0].body.extra",
      failure(request(""""method":"POST","body":{"state":"q","extra":1}"""))?.path,
    )
  }

  @Test
  fun `timeoutMs is bounded by the contract maximum`() {
    assertValid(
      request(""""timeoutMs":${PrototypeSpecValidator.MAX_PROTOTYPE_REQUEST_TIMEOUT_MS}"""),
    )
    for (bad in listOf("30001", "0", "1.5")) {
      assertEquals("root.onTap[0].timeoutMs", failure(request(""""timeoutMs":$bad"""))?.path, bad)
    }
  }

  @Test
  fun `unknown fields, a bad method and an empty follow-up list are refused`() {
    assertEquals("root.onTap[0].extra", failure(request(""""extra":1"""))?.path)
    assertEquals("root.onTap[0].method", failure(request(""""method":"TRACE""""))?.path)
    assertEquals("root.onTap[0].onSuccess", failure(request(""""onSuccess":[]"""))?.path)
    assertEquals("root.onTap[0].via", failure(request(""""via":"proxy""""))?.path)
  }

  @Test
  fun `follow-up actions are validated like any action at their nested path`() {
    assertEquals(
      PrototypeSpecError("root.onTap[0].onError[0].key", "Toggle requires a boolean state key"),
      failure(request(""""onError":[{"type":"toggle","key":"count"}]""")),
    )
    assertEquals(
      "root.onTap[0].onSuccess[0].type",
      failure(request(""""onSuccess":[{"type":"bogus"}]"""))?.path,
    )
    assertEquals(
      PrototypeSpecError("root.onTap[0].onSuccess[0].stack", "Unknown stack id"),
      failure(request(""""onSuccess":[{"type":"pop","stack":"nope"}]""")),
    )
  }

  @Test
  fun `nested follow-ups are bounded by the action depth limit`() {
    val depth = PrototypeSpecValidator.MAX_PROTOTYPE_ACTION_DEPTH
    fun nested(levels: Int): String =
      if (levels == 1) request() else request(""""onSuccess":[${nested(levels - 1)}]""")
    assertValid(nested(depth))
    val over = failure(nested(depth + 1))
    assertEquals("Action nesting limit exceeded", over?.message)
    assertEquals(depth, over!!.path.split("onSuccess").size - 1)
  }

  @Test
  fun `the emit name used for request events is reserved`() {
    assertEquals(
      PrototypeSpecError(
        "root.onTap[0].name",
        "The emit name prototype_request is reserved for request events",
      ),
      failure("""{"type":"emit","name":"prototype_request"}"""),
    )
  }

  @Test
  fun `inside a repeat statusKey and into bind per row`() {
    fun repeatSpec(state: String) =
      """{"id":"req","window":{"placement":{"type":"fullscreen"}},"state":$state,"data":{"rows":[{},{}]},""" +
        """"root":{"type":"column","repeat":{"items":[{"id":"a"},{"id":"b"}],"as":"row"},"children":[""" +
        """{"type":"button","label":"Go","onTap":[{"type":"request","url":"http://localhost/{row.id}",""" +
        """"into":"/data/rows/{index}/body","statusKey":"s_{row.id}"}]}]}}"""
    val ok = PrototypeSpecValidator.validate(repeatSpec("""{"s_a":"idle","s_b":"idle"}"""))
    assertTrue(ok is PrototypeSpecValidation.Success, ok.toString())
    assertTrue(
      PrototypeSpecValidator.validate(repeatSpec("""{"s_a":"idle"}"""))
        is PrototypeSpecValidation.Failure,
    )
  }

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
    assertEquals(obj("""{"state":"q"}"""), decoded.headers!!.getValue("B"))
    assertEquals(obj("""{"value":{"k":true}}"""), decoded.body)
    assertEquals(PrototypeDismissAction, decoded.onError!!.single())
  }

  // ---- resolution ----

  private val inputs =
    object : EmitContextInputs {
      private val state = mapOf("q" to "cats", "n" to 3, "on" to true)
      private val data = obj("""{"title":"Feed","obj":{"a":1}}""")

      override fun state(key: String): JsonElement? =
        when (val value = state[key]) {
          null -> null
          is String -> JsonPrimitive(value)
          is Int -> JsonPrimitive(value)
          else -> JsonPrimitive(value as Boolean)
        }

      override fun page(id: String): Int? = null

      override fun data(pointer: String): JsonElement? = PrototypeDataPointer.resolve(data, pointer)
    }

  private fun action(json: String): PrototypeRequestAction =
    Json.decodeFromJsonElement(PrototypeAction.serializer(), obj(json)) as PrototypeRequestAction

  private fun resolved(
    json: String,
    url: String = "http://localhost:8080/feed",
  ): PrototypeResolvedRequest =
    (PrototypeRequestResolver.resolve(action(json), url, inputs)
        as PrototypeResolvedRequestResult.Success)
      .request

  private fun failed(json: String, url: String = "http://a.test"): PrototypeRequestError =
    (PrototypeRequestResolver.resolve(action(json), url, inputs)
        as PrototypeResolvedRequestResult.Failure)
      .error

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
    assertEquals("http://localhost:8080/feed?q=cats&n=3&flag=true&z=9", request.url)
    assertEquals(mapOf("A" to "lit", "B" to "cats", "C" to "Feed", "D" to "5"), request.headers)
    assertEquals(obj("""{"k":1}"""), request.body)
    val bare = resolved("""{"type":"request","url":"x"}""", "https://a.test")
    assertEquals("GET", bare.method)
    assertEquals(emptyMap<String, String>(), bare.headers)
    assertEquals("https://a.test/", bare.url)
    assertNull(bare.body)
  }

  @Test
  fun `a query key already in the url is replaced and a duplicate is dropped`() {
    val url = resolved(request(""""query":{"a":"2"}"""), "http://h.test/p?a=1&b=x%20y&a=3&c").url
    assertEquals("http://h.test/p?a=2&b=x+y&c=", url)
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

  private fun received(
    body: JsonElement?,
    status: Int = 200,
    headers: Map<String, String> = jsonHeaders,
  ) = PrototypeRequestResponse.Received(status, headers, body, 12)

  private val jsonHeaders = mapOf("content-type" to "application/json")

  private fun applied(
    data: String,
    into: String?,
    response: PrototypeRequestResponse,
  ): PrototypeRequestApplied = PrototypeRequestOutcome.apply(obj(data), into, response)

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
    assertEquals(JsonPrimitive(""), applied("{}", "/data/t", received(JsonNull)).data!!["t"])
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
      result.data!!["feed__meta"],
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
    val meta = result.data!!["feed__meta"]!!.jsonObject
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
    assertEquals(obj("""{"status":200,"durationMs":12}"""), result.data!!["feed__meta"])
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
