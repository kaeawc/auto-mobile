package dev.jasonpearson.automobile.protocol

import java.io.File
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * R2 parity with TypeScript and Swift (#15635), including the shared `library-sensitive` corpus.
 */
class PrototypeSensitiveSinkRulesTest {
  private val message = PrototypeSensitiveSinkRules.MESSAGE
  private val requestPath = "root.children[1].onTap[0]"

  private fun spec(
    sink: String = """"query":{"q":{"data":"/code"}}""",
    into: String = "/data/code",
    repeat: String? = null,
    extra: String = "",
    first: String = """{"type":"pasteButton","into":"$into"}""",
  ): String {
    val url = if (sink.contains("\"url\"")) "" else """"url":"https://example.com/submit","""
    val repeatField = repeat?.let { """"repeat":$it,""" }.orEmpty()
    return """{"id":"sensitive-flow","window":{"placement":{"type":"fullscreen"}},""" +
      """"requires":{"platform":["clipboard"]},$extra""" +
      """"root":{"type":"column",$repeatField"children":[$first,""" +
      """{"type":"button","label":"Send","onTap":[{"type":"request",$url"via":"device",$sink}]}]}}"""
  }

  private fun assertSink(input: String, path: String?) {
    assertTrue(
      PrototypeSpecValidator.validate(input) is PrototypeSpecValidation.Success,
      "non-library show must accept: $input",
    )
    val library = PrototypeSpecValidator.validate(input, library = true)
    if (path == null) {
      assertTrue(library is PrototypeSpecValidation.Success, "library must accept: $library")
    } else {
      assertEquals(
        PrototypeSpecError(path, message),
        (library as? PrototypeSpecValidation.Failure)?.error,
        input,
      )
    }
  }

  private fun errors(input: String): List<PrototypeSpecError> {
    val context = PrototypeStateChecks.Context()
    val result = PrototypeSpecInput.validateInput(input, context)
    assertTrue(result !is PrototypeSpecValidation.Failure, result.toString())
    return PrototypeSensitiveSinkRules.errors(checkNotNull(context.root).jsonObject, context)
  }

  @Test
  fun `shared library-sensitive fixtures match TypeScript and Swift`() {
    val files =
      File(fixtureDirectory(), "library-sensitive")
        .listFiles { file -> file.extension == "json" }
        .orEmpty()
        .sortedBy { it.name }
    assertEquals(8, files.size)
    for (file in files) {
      val fixture = PrototypeSpecValidator.json.parseToJsonElement(file.readText()).jsonObject
      val input = fixture.getValue("spec").toString()
      val path = fixture["expectedPath"]?.jsonPrimitive?.content
      val library = fixture.getValue("options").jsonObject["library"]?.jsonPrimitive?.booleanOrNull
      assertEquals(path != null, library, file.name)
      val expected =
        path?.let {
          listOf(PrototypeSpecError(it, fixture.getValue("expectedMessage").jsonPrimitive.content))
        } ?: emptyList()
      assertEquals(expected, errors(input), file.name)
      if (path != null) assertSink(input, path)
      else
        assertTrue(
          PrototypeSpecValidator.validate(input) is PrototypeSpecValidation.Success,
          file.name,
        )
    }
  }

  @Test
  fun `request sink kinds are refused and opaque or untainted bindings are accepted`() {
    for ((sink, suffix) in
      listOf(
        """"query":{"q":{"data":"/code"}}""" to "query.q",
        """"headers":{"Authorization":{"data":"/code"}}""" to "headers.Authorization",
        """"method":"POST","body":{"data":"/code"}""" to "body",
        """"method":"POST","body":{"form":{"q":{"data":"/code"}}}""" to "body.form.q",
        """"method":"POST","body":{"multipart":[{"name":"q","value":{"data":"/code"}}]}""" to
          "body.multipart[0].value",
        """"url":"https://example.com/{data:/code}"""" to "url",
        """"headers":{"X-Code":"{data:/code}"}""" to """headers["X-Code"]""",
        """"query":{"q":"{data:/code}"}""" to "query.q",
      )) {
      assertSink(spec(sink), "$requestPath.$suffix")
    }
    assertSink(spec(""""query":{"q":{"value":"{data:/code}"}}"""), null)
    assertSink(spec(""""query":{"q":{"data":"/other"}}"""), null)
  }

  @Test
  fun `a nested data token consumes the whole placeholder`() {
    assertSink(spec(""""query":{"q":"{data:/other{data:/code}}"}"""), null)
    assertSink(
      spec(""""query":{"q":"{data:/other{data:/code}}{data:/code}"}"""),
      "$requestPath.query.q",
    )
  }

  @Test
  fun `platform handler requests are sinks`() {
    val request =
      """[{"type":"request","url":"https://example.com/submit","via":"device",""" +
        """"query":{"q":{"data":"/code"}}}]"""
    val input =
      spec(extra = """"platform":{"on":{"battery.changed":$request}},""")
        .replace(""""platform":["clipboard"]""", """"platform":["clipboard","battery"]""")
    assertEquals(
      PrototypeSpecError("""platform.on["battery.changed"][0].query.q""", message),
      errors(input).first(),
    )
  }

  @Test
  fun `pointers overlap by segment and only a taint index is a wildcard for typed sinks`() {
    for ((into, pointer, refused) in
      listOf(
        Triple("/data/user/name", "/user", true),
        Triple("/data/user/name", "/user/name/first", true),
        Triple("/data/user/name", "/user/email", false),
        Triple("/data/code", "/codeword", false),
        Triple("/data/users/0/token", "/users/{index}", false),
        Triple("/data/users/{index}/token", "/users/0", true),
        Triple("/data/users/{index}/token", "/other/0", false),
        Triple("/data/é", "/é", false),
      )) {
      val input =
        spec(
          """"query":{"q":{"data":"$pointer"}}""",
          into = into,
          repeat = """{"items":[{"key":"code"}],"as":"row"}""",
        )
      assertEquals(
        if (refused) listOf(PrototypeSpecError("$requestPath.query.q", message)) else emptyList(),
        errors(input),
        "$into -> $pointer",
      )
    }
  }

  @Test
  fun `live data-backed rows refuse row reads and literal rows do not`() {
    for (binding in listOf("\"{row.code}\"", """{"item":"code"}""", "\"static\"")) {
      val reads = binding != "\"static\""
      val live =
        spec(
          """"query":{"q":$binding}""",
          into = "/data/rows/0/code",
          repeat = """{"items":{"path":"/rows"},"as":"row"}""",
          extra = """"data":{"rows":[{"code":"authored"}]},""",
        )
      assertEquals(reads, errors(live).isNotEmpty(), "live $binding")
      val literal =
        spec(
          """"query":{"q":$binding}""",
          into = "/data/rows/0/code",
          repeat = """{"items":[{"code":"authored"}],"as":"row"}""",
        )
      assertEquals(emptyList<PrototypeSpecError>(), errors(literal), "literal $binding")
    }
  }

  @Test
  fun `a sensitive platform action taints and an emit payload stays opaque`() {
    val paste =
      """{"type":"button","label":"Paste","onTap":[{"type":"platform",""" +
        """"call":"clipboard.paste","into":"/data/code"}]}"""
    assertEquals(
      listOf(PrototypeSpecError("$requestPath.query.q", message)),
      errors(spec(first = paste)),
    )
    val emit =
      """{"type":"button","label":"Emit","onTap":[{"type":"emit","name":"literal",""" +
        """"payload":{"type":"platform","call":"clipboard.paste","into":"/data/code"}}]}"""
    assertEquals(emptyList<PrototypeSpecError>(), errors(spec(first = emit)))
  }

  @Test
  fun `non-sensitive specs return no sink errors`() {
    val input = spec(first = """{"type":"text","text":"hi"}""")
    assertNull(
      PrototypeSensitiveSinkRules.error(
        PrototypeSpecValidator.json.parseToJsonElement(input) as JsonObject,
        PrototypeStateChecks.Context().also { PrototypeSpecInput.validateInput(input, it) },
      ),
    )
  }
}
