package dev.jasonpearson.automobile.protocol

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test

/**
 * The Kotlin twin of `test/features/prototype/prototypeRequest.test.ts` (#12523): the same
 * validation verdicts, paths and messages, and the same resolution and response semantics.
 */
abstract class PrototypeRequestTestSupport {
  companion object {
    @JvmStatic
    @BeforeAll
    fun warmValidator() {
      PrototypeSpecValidator.validate("{}")
    }
  }

  protected fun obj(text: String): JsonObject = Json.parseToJsonElement(text).jsonObject

  protected fun request(extra: String = ""): String =
    """{"type":"request","url":"http://localhost:8080/feed","into":"/data/feed"${
      if (extra.isEmpty()) "" else ",$extra"
    }}"""

  protected fun spec(
    actions: String,
    state: String = """{"status":"idle","count":0,"flag":false,"q":"a"}""",
  ) =
    """{"id":"req","window":{"placement":{"type":"fullscreen"}},"state":$state,"data":{"title":"T"},"root":{"type":"button","label":"Go","onTap":[$actions]}}"""

  protected fun check(action: String, state: String? = null): PrototypeSpecValidation =
    PrototypeSpecValidator.validate(if (state == null) spec(action) else spec(action, state))

  protected fun failure(action: String): PrototypeSpecError? =
    (check(action) as? PrototypeSpecValidation.Failure)?.error

  protected fun assertValid(action: String) = assertNull(failure(action), action)

  // ---- validation ----

  protected val inputs =
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

  protected fun action(json: String): PrototypeRequestAction =
    Json.decodeFromJsonElement(PrototypeAction.serializer(), obj(json)) as PrototypeRequestAction

  protected fun resolved(
    json: String,
    url: String = "http://localhost:8080/feed",
  ): PrototypeResolvedRequest =
    (PrototypeRequestResolver.resolve(action(json), url, inputs)
        as PrototypeResolvedRequestResult.Success)
      .request

  protected fun failed(json: String, url: String = "http://a.test"): PrototypeRequestError =
    (PrototypeRequestResolver.resolve(action(json), url, inputs)
        as PrototypeResolvedRequestResult.Failure)
      .error

  protected fun received(
    body: JsonElement?,
    status: Int = 200,
    headers: Map<String, String> = jsonHeaders,
  ) = PrototypeRequestResponse.Received(status, headers, body, 12)

  protected val jsonHeaders = mapOf("content-type" to "application/json")

  protected fun applied(
    data: String,
    into: String?,
    response: PrototypeRequestResponse,
  ): PrototypeRequestApplied = PrototypeRequestOutcome.apply(obj(data), into, response)
}

class PrototypeRequestTest : PrototypeRequestTestSupport() {
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
  fun `a bound JSON number is header and query text by JavaScript number rules`() {
    val file =
      generateSequence(File(System.getProperty("user.dir") ?: ".").absoluteFile) { it.parentFile }
        .map { File(it, "test/fixtures/prototype/request-number-text.json") }
        .first { it.isFile }
    val vectors = Json.parseToJsonElement(file.readText()).jsonArray
    assertTrue(vectors.size >= 8)
    for (vector in vectors) {
      val json = vector.jsonObject.getValue("json").jsonPrimitive.content
      val text = vector.jsonObject.getValue("text").jsonPrimitive.content
      val request =
        resolved(
          request(""""headers":{"A":{"value":$json}},"query":{"n":{"value":$json}}"""),
          "http://localhost:8080/feed",
        )
      assertEquals(text, request.headers["A"], "header for $json")
      assertEquals(
        "http://localhost:8080/feed?n=" + java.net.URLEncoder.encode(text, Charsets.UTF_8),
        request.url,
        "query for $json",
      )
    }
  }

  @Test
  fun `header names that differ only by case are refused`() {
    val headers = request(""""headers":{"X-Test":"1","x-test":"2"}""")
    assertEquals("root.onTap[0].headers[\"x-test\"]", failure(headers)?.path)
    assertEquals(
      PrototypeRequestErrorCode.INVALID_REQUEST,
      (PrototypeRequestResolver.resolve(action(headers), "http://a.test", inputs)
          as PrototypeResolvedRequestResult.Failure)
        .error
        .code,
    )
  }

  @Test
  fun `a json object body serializes with its keys sorted at every depth`() {
    val body =
      resolved(
          request(""""method":"POST","body":{"value":{"b":1,"a":{"d":[{"z":1,"y":2}],"c":3}}}"""),
          "http://a.test",
        )
        .body
    assertEquals("""{"a":{"c":3,"d":[{"y":2,"z":1}]},"b":1}""", body.toString())
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
}
