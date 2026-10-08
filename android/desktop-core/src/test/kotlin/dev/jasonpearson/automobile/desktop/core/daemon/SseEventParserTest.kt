package dev.jasonpearson.automobile.desktop.core.daemon

import kotlin.test.assertEquals
import org.junit.Test

class SseEventParserTest {

  @Test
  fun `parses the daemon's keepalive plus message frame`() {
    val events = SseEventParser.parse(":keepalive\n\nevent: message\ndata: {\"a\":1}\n\n")

    assertEquals(listOf(SseEvent(name = "message", data = "{\"a\":1}", id = null)), events)
  }

  @Test
  fun `two events arriving in one body are both returned in order`() {
    val events = SseEventParser.parse("data: one\n\nid: 2\nevent: message\ndata: two\n\n")

    assertEquals(
      listOf(SseEvent(null, "one", null), SseEvent("message", "two", "2")),
      events,
    )
  }

  @Test
  fun `multi-line data is joined with a newline`() {
    val events = SseEventParser.parse("data: {\"a\":\ndata: 1}\n\n")

    assertEquals("{\"a\":\n1}", events.single().data)
  }

  @Test
  fun `CRLF, LF and bare CR all terminate lines`() {
    val crlf = SseEventParser.parse("event: m\r\ndata: x\r\n\r\n")
    val cr = SseEventParser.parse("event: m\rdata: x\r\r")
    val mixed = SseEventParser.parse("event: m\ndata: x\r\n\r")

    val expected = listOf(SseEvent("m", "x", null))
    assertEquals(expected, crlf)
    assertEquals(expected, cr)
    assertEquals(expected, mixed)
  }

  @Test
  fun `comments and unknown fields are ignored and only one leading space is dropped`() {
    val events = SseEventParser.parse(":c\nretry: 3000\nfoo: bar\ndata:  two spaces\n\n")

    assertEquals(" two spaces", events.single().data)
    assertEquals(null, events.single().name)
  }

  @Test
  fun `a field without a colon has an empty value`() {
    val events = SseEventParser.parse("data\n\n")

    assertEquals("", events.single().data)
  }

  @Test
  fun `an empty data priming event is dispatched with blank data`() {
    val events = SseEventParser.parse("id: 1\nretry: 1000\ndata: \n\n")

    assertEquals(listOf(SseEvent(null, "", "1")), events)
  }

  @Test
  fun `a trailing event without a terminating blank line is still dispatched`() {
    assertEquals("tail", SseEventParser.parse("data: head\n\ndata: tail").last().data)
    assertEquals("tail", SseEventParser.parse("data: tail\n").single().data)
  }

  @Test
  fun `event name and id do not leak into the next event`() {
    val events = SseEventParser.parse("event: a\nid: 1\ndata: x\n\ndata: y\n\n")

    assertEquals(SseEvent(null, "y", null), events[1])
  }

  @Test
  fun `a stream with no data produces no events`() {
    assertEquals(emptyList(), SseEventParser.parse(""))
    assertEquals(emptyList(), SseEventParser.parse(":keepalive\n\n:keepalive\n\n"))
    assertEquals(emptyList(), SseEventParser.parse("event: ping\n\n"))
  }

  @Test
  fun `a leading byte order mark and multi-byte text are preserved correctly`() {
    val events = SseEventParser.parse("﻿data: héllo 日本語 🚀\n\n")

    assertEquals("héllo 日本語 🚀", events.single().data)
  }
}
