package dev.jasonpearson.automobile.desktop.core.telemetry

import dev.jasonpearson.automobile.desktop.core.clipboard.FakeClipboardWriter
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class InspectorEventExportTest {

  private fun networkFixture(): TelemetryDisplayEvent.Network =
    TelemetryDisplayEvent.Network(
      timestamp = 1000L,
      method = "POST",
      statusCode = 201,
      url = "https://api.example.com/v1/items",
      durationMs = 42L,
      host = "api.example.com",
      path = "/v1/items",
      error = null,
      // LinkedHashMap preserves insertion order so the exported command is deterministic.
      requestHeaders =
        linkedMapOf(
          "Content-Type" to "application/json",
          "Authorization" to "Bearer super-secret-token",
        ),
      responseHeaders = null,
      requestBody = "{\"name\":\"O'Brien\"}",
      responseBody = null,
      contentType = "application/json",
    )

  @Test
  fun `networkAsCurl reproduces the captured request`() {
    val curl = networkAsCurl(networkFixture())

    assertTrue("method", curl.contains("curl -X POST"))
    assertTrue("content-type header", curl.contains("-H 'Content-Type: application/json'"))
    // Single quote in the body is shell-escaped: O'Brien -> O'\''Brien
    assertTrue("request body", curl.contains("-d '{\"name\":\"O'\\''Brien\"}'"))
    assertTrue("url", curl.contains("'https://api.example.com/v1/items'"))
  }

  @Test
  fun `networkAsCurl redacts secret headers and never leaks the value`() {
    val curl = networkAsCurl(networkFixture())

    assertTrue("authorization redacted", curl.contains("-H 'Authorization: [REDACTED]'"))
    assertFalse("secret token absent", curl.contains("super-secret-token"))
  }

  @Test
  fun `copyNetworkAsCurl writes the curl command through the injected clipboard`() {
    val event = networkFixture()
    val clipboard = FakeClipboardWriter()

    clipboard.copyNetworkAsCurl(event)

    assertEquals(networkAsCurl(event), clipboard.lastText)
  }

  @Test
  fun `eventAsMarkdown emits a deterministic table for a network event`() {
    val event = networkFixture()

    val expected = buildString {
      appendLine("| Field | Value |")
      appendLine("|-------|-------|")
      appendLine("| Type | Network |")
      appendLine("| Time | 1000 |")
      appendLine("| URL | https://api.example.com/v1/items |")
      appendLine("| Method | POST |")
      appendLine("| Status | 201 |")
      appendLine("| Duration | 42ms |")
    }

    assertEquals(expected, eventAsMarkdown(event))
    // Deterministic: the same event always yields byte-identical Markdown.
    assertEquals(eventAsMarkdown(event), eventAsMarkdown(event))
  }

  @Test
  fun `eventAsMarkdown escapes pipe characters so the table stays well-formed`() {
    val log = TelemetryDisplayEvent.Log(timestamp = 5L, level = 4, tag = "Net", message = "a | b")

    val markdown = eventAsMarkdown(log)

    assertTrue("pipe escaped", markdown.contains("| Message | a \\| b |"))
  }

  @Test
  fun `copyEventAsMarkdown writes the markdown table through the injected clipboard`() {
    val event = networkFixture()
    val clipboard = FakeClipboardWriter()

    clipboard.copyEventAsMarkdown(event)

    assertEquals(eventAsMarkdown(event), clipboard.lastText)
  }
}
