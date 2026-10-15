package dev.jasonpearson.automobile.ctrlproxy

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class WireJsonFieldsTest {
  private val json = Json { prettyPrint = false }

  @Test
  fun `hostile string fields round trip without injecting keys`() {
    val values =
      listOf(
        "a\"b",
        "a\\b",
        "\"},\"success\":true,\"x\":\"",
        "line\nnext\t\u0000\u0001\u001F",
        "\u2028",
        "",
      )
    for (name in listOf("requestId", "frameContext")) {
      for (value in values) {
        val wire = buildString {
          append("""{"type":"result"""")
          appendJsonStringField(name, value, json)
          append('}')
        }
        val obj = json.parseToJsonElement(wire).jsonObject
        assertEquals(setOf("type", name), obj.keys)
        assertEquals("result", obj["type"]!!.jsonPrimitive.content)
        assertEquals(value, obj[name]!!.jsonPrimitive.content)
      }
    }
  }

  @Test
  fun `ordinary fields retain exact compact wire bytes`() {
    val wire = buildString {
      append("""{"type":"result"""")
      appendJsonStringField("requestId", "request-123", json)
      appendJsonStringField("frameContext", "frame-456", json)
      append('}')
    }
    assertEquals(
      """{"type":"result","requestId":"request-123","frameContext":"frame-456"}""",
      wire,
    )
  }

  @Test
  fun `field names are escaped too`() {
    val wire = buildString {
      append("""{"type":"result"""")
      appendJsonStringField("a\"b", "value", json)
      append('}')
    }
    val obj = json.parseToJsonElement(wire).jsonObject
    assertEquals(setOf("type", "a\"b"), obj.keys)
    assertEquals("value", obj["a\"b"]!!.jsonPrimitive.content)
  }

  @Test
  fun `main sources never interpolate unescaped requestId or frameContext strings`() {
    val sources = locateMainSources().walkTopDown().filter { it.isFile && it.extension == "kt" }
    val forbidden = listOf("\"requestId\":\"\$", "\"frameContext\":\"\$")
    val violations =
      sources
        .flatMap { file ->
          file.readLines().mapIndexedNotNull { index, line ->
            if (forbidden.any { it in line }) "${file.path}:${index + 1}" else null
          }
        }
        .toList()
    assertTrue("Unescaped JSON string interpolation: $violations", violations.isEmpty())
  }

  private fun locateMainSources(): File {
    val relative = "src/main"
    var directory: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
    while (directory != null) {
      for (candidate in
        listOf(
          File(directory, relative),
          File(directory, "control-proxy/$relative"),
          File(directory, "android/control-proxy/$relative"),
        )) {
        if (File(candidate, "kotlin/dev/jasonpearson/automobile/ctrlproxy/CtrlProxy.kt").isFile) {
          return candidate
        }
      }
      directory = directory.parentFile
    }
    error("Could not locate control-proxy main sources from user.dir")
  }
}
