package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import java.io.File
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test

/**
 * The `request` action on the device (#12528): the status lifecycle, the response written through
 * the data-write path, the `prototype_request` event, follow-ups, and the concurrency rules. A fake
 * [PrototypeHttpClient] answers when the test says so, and the request scope is the test's own, so
 * nothing waits on a real network or a real clock.
 */
class PrototypeRequestUploadRuntimeTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun warmValidator() {
      PrototypeSpecValidator.validate("{}")
    }
  }

  /** Records each request and holds it until the test answers (or the runtime cancels it). */
  private class FakeHttp(val name: String) : PrototypeHttpClient {
    val requests = mutableListOf<PrototypeHttpRequest>()
    val cancelled = mutableListOf<String>()
    private val answers = mutableListOf<CompletableDeferred<PrototypeRequestResponse>>()

    override suspend fun execute(request: PrototypeHttpRequest): PrototypeRequestResponse {
      val answer = CompletableDeferred<PrototypeRequestResponse>()
      requests += request
      answers += answer
      try {
        return answer.await()
      } catch (error: kotlinx.coroutines.CancellationException) {
        cancelled += request.requestId
        throw error
      }
    }

    fun answer(index: Int, response: PrototypeRequestResponse) {
      answers[index].complete(response)
    }
  }

  private val host = FakeHttp("host")
  private val device = FakeHttp("device")
  private val events = mutableListOf<PrototypeEvent>()
  private val warnings = mutableListOf<String>()
  private var sequence = 0L
  private var requestIds = 0
  private var now = 1_000L

  private fun spec(
    actions: String,
    state: String = """{"status":"idle","count":0,"flag":false,"q":"cats"}""",
  ): PrototypeSpec {
    val input =
      """{"id":"req","window":{"placement":{"type":"fullscreen"}},"state":$state,"data":{"title":"Feed"},""" +
        """"root":{"type":"column","children":[{"type":"button","label":"Go","onTap":[$actions]}]}}"""
    val validation = PrototypeSpecValidator.validate(input)
    return (validation as? PrototypeSpecValidation.Success)?.spec ?: error(validation.toString())
  }

  private fun request(extra: String = "") =
    """{"type":"request","url":"http://localhost:8080/feed","into":"/data/feed","statusKey":"status"${
      if (extra.isEmpty()) "" else ",$extra"
    }}"""

  private fun TestScope.runtime(
    spec: PrototypeSpec,
    limiter: PrototypeRequestLimiter = PrototypeRequestLimiter(),
    assets: PrototypeAssetSource? = null,
  ) =
    PrototypeRuntime(
      spec,
      PrototypeEventSink { events += it },
      { now },
      { ++sequence },
      warn = { warnings += it },
      httpClients = PrototypeHttpClients(host, device),
      requestScope = backgroundScope,
      newRequestId = { "r-${++requestIds}" },
      requestLimiter = limiter,
      uploadAssets = assets,
    )

  private fun tapOf(runtime: PrototypeRuntime) =
    PrototypeInteraction.Tap(checkNotNull(runtime.renderModel().root.children[0].source?.onTap))

  private fun received(body: JsonElement?, status: Int = 200) =
    PrototypeRequestResponse.Received(
      status,
      mapOf("content-type" to "application/json"),
      body,
      31,
    )

  private fun requestEvents(): List<JsonObject> =
    events
      .filter { it.kind == PrototypeEventKind.EMIT && it.name == PrototypeRequests.EVENT_NAME }
      .map { it.payload as JsonObject }

  private fun upload(body: String, via: String = "device") =
    request("\"method\":\"POST\",\"via\":\"$via\",\"body\":$body,\"progressKey\":\"count\"")

  @Test
  fun `multipart resolves scalar bindings and streams the stored file with byte accounting`() =
    runTest {
      val file = File.createTempFile("prototype-upload", ".bin")
      try {
        file.writeBytes(byteArrayOf(0, 1, -1, 42))
        val assets =
          object : PrototypeAssetSource {
            override fun file(id: String): File? = if (id == "hero") file else null

            override fun lookup(id: String): PrototypeAssetInfo? = error("Do not buffer uploads")

            override fun read(id: String): ByteArray? = error("Do not buffer uploads")

            override fun setChangeListener(listener: PrototypeAssetChangeListener?) = Unit
          }
        val runtime =
          runtime(
            spec(
              upload(
                """{"multipart":[{"name":"caption","value":{"state":"q"}},{"name":"photo","file":{"asset":"hero"}}]}""",
              ),
            ),
            assets = assets,
          )
        runtime.handle(tapOf(runtime))
        runCurrent()
        val sent = device.requests.single()
        assertNull(sent.body)
        val parts = (sent.uploadBody as PrototypeUploadBody.Multipart).parts
        assertEquals("cats", parts[0].value)
        assertEquals(file, parts[1].file!!.file)
        assertEquals("hero", parts[1].filename)
        assertEquals("application/octet-stream", parts[1].file!!.contentType)
        sent.onUploadProgress!!.invoke(45)
        runCurrent()
        assertEquals(PrototypeScalar.Numeric(45.0), runtime.current.state["count"])
        device.answer(0, received(JsonPrimitive("ok")))
        runCurrent()
        assertEquals(PrototypeScalar.Numeric(100.0), runtime.current.state["count"])
        assertEquals(4, requestEvents().single().getValue("uploadBytes").jsonPrimitive.int)
      } finally {
        file.delete()
      }
    }

  @Test
  fun `unknown assets fail as invalid request before transport`() = runTest {
    val runtime =
      runtime(spec(upload("""{"file":{"asset":"missing"},"contentType":"image/png"}""")))
    runtime.handle(tapOf(runtime))
    runCurrent()
    assertTrue(device.requests.isEmpty())
    val error = requestEvents().single().getValue("error").jsonObject
    assertEquals("invalid_request", error.getValue("code").jsonPrimitive.content)
    assertTrue(error.getValue("message").jsonPrimitive.content.contains("missing"))
  }

  @Test
  fun `raw upload resolves a file and rejects aggregate bytes over the limit`() = runTest {
    val file = File.createTempFile("prototype-upload", ".bin")
    try {
      file.writeBytes(byteArrayOf(1, 2, 3))
      val assets =
        object : PrototypeAssetSource {
          override fun file(id: String): File? = file

          override fun lookup(id: String): PrototypeAssetInfo? = error("No whole-file reads")

          override fun read(id: String): ByteArray? = error("No whole-file reads")

          override fun setChangeListener(listener: PrototypeAssetChangeListener?) = Unit
        }
      val actions = upload("""{"file":{"asset":"hero"},"contentType":"image/png"}""")
      val runtime = runtime(spec(actions), assets = assets)
      runtime.handle(tapOf(runtime))
      runCurrent()
      assertEquals(
        PrototypeUploadBody.FileBody(file, "image/png"),
        device.requests.single().uploadBody,
      )
      java.io.RandomAccessFile(file, "rw").use {
        it.setLength(PrototypeSpecValidator.MAX_PROTOTYPE_UPLOAD_BYTES.toLong() + 1)
      }
      runtime.handle(tapOf(runtime))
      runCurrent()
      assertEquals(1, device.requests.size)
      val error = requestEvents().last().getValue("error").jsonObject
      assertEquals("invalid_request", error.getValue("code").jsonPrimitive.content)
      assertTrue(error.getValue("message").jsonPrimitive.content.contains("smaller assets"))
    } finally {
      file.delete()
    }
  }

  @Test
  fun `missing upload binding fails explicitly instead of dropping a form entry`() = runTest {
    val runtime = runtime(spec(upload("""{"form":{"q":{"data":"/missing"}}}""")))
    runtime.handle(tapOf(runtime))
    runCurrent()
    assertTrue(device.requests.isEmpty())
    assertEquals(
      "invalid_request",
      requestEvents().single().getValue("error").jsonObject.getValue("code").jsonPrimitive.content,
    )
  }

  @Test
  fun `host uploads fail with device guidance without invoking a client`() = runTest {
    val runtime = runtime(spec(upload("""{"form":{"q":{"state":"q"}}}""", via = "host")))
    runtime.handle(tapOf(runtime))
    runCurrent()
    assertTrue(host.requests.isEmpty())
    val error = requestEvents().single().getValue("error").jsonObject
    assertEquals("invalid_request", error.getValue("code").jsonPrimitive.content)
    assertTrue(error.getValue("message").jsonPrimitive.content.contains("device"))
  }

  @Test
  fun `form resolves state and literal values and stale progress is ignored`() = runTest {
    val runtime = runtime(spec(upload("""{"form":{"q":{"state":"q"},"n":{"value":2}}}""")))
    runtime.handle(tapOf(runtime))
    runCurrent()
    val sent = device.requests.single()
    assertEquals(
      mapOf("q" to "cats", "n" to "2"),
      (sent.uploadBody as PrototypeUploadBody.Form).entries,
    )
    runtime.dismiss()
    sent.onUploadProgress!!.invoke(75)
    runCurrent()
    assertEquals(PrototypeScalar.Numeric(0.0), runtime.current.state["count"])
  }
}
