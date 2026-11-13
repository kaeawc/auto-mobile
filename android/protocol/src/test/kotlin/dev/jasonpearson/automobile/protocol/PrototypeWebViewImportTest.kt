package dev.jasonpearson.automobile.protocol

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class PrototypeWebViewImportTest {
  private val fixture = File(fixtureDirectory(), "valid/webview-node.json").readText()

  @Test
  fun `network switch refuses first page and allows the same fixture when enabled`() {
    val spec = Json.parseToJsonElement(fixture).jsonObject
    assertEquals("root.children[1]", PrototypeWebView.importError(spec, false)?.path)
    assertEquals(
      PrototypeWebView.importError(spec, false),
      PrototypeWebView.importError(fixture, false),
    )
    assertNull(PrototypeWebView.importError(spec, true))
  }

  @Test
  fun `opaque data and action payloads are not nodes`() {
    val spec =
      """{"data":{"type":"webView"},"root":{"type":"button","onTap":[{"type":"emit","payload":{"type":"webView"}}]}}"""
    assertNull(PrototypeWebView.importError(spec, false))
  }

  @Test
  fun `nested repeat template is checked even with no items and first page wins`() {
    val spec =
      """{"root":{"type":"column","repeat":{"items":[],"as":"item"},"children":[{"type":"box","child":{"type":"webView"}},{"type":"webView"}]}}"""
    assertEquals("root.children[0].child", PrototypeWebView.importError(spec, false)?.path)
  }

  @Test
  fun `malformed saved data returns null instead of throwing, as in Swift`() {
    assertNull(PrototypeWebView.importError("{not json", false))
    assertNull(PrototypeWebView.importError("[]", false))
  }

  @Test
  fun `shared cases pin the first reported path independent of key order`() {
    val cases =
      Json.parseToJsonElement(File(fixtureDirectory(), "webview-import/cases.json").readText())
        .jsonArray
    assertTrue(cases.isNotEmpty())
    cases.forEach {
      val case = it.jsonObject
      val expected = case["path"]?.takeUnless { path -> path is JsonNull }?.jsonPrimitive?.content
      val name = case["name"]?.jsonPrimitive?.content
      val spec = case.getValue("spec").jsonObject
      assertEquals(expected, PrototypeWebView.importError(spec, false)?.path, name)
      assertEquals(expected, PrototypeWebView.importError(spec.toString(), false)?.path, name)
    }
  }
}
