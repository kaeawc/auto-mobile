package dev.jasonpearson.automobile.sdk.anr

import java.io.ByteArrayInputStream
import java.io.InputStream
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.junit.Test

/**
 * Deterministic pure-JVM tests, without Robolectric or Android API-level annotations. Narrow
 * reflection reaches the private pure seams because this module's javap-based API checker also
 * records Kotlin internal members. No ApplicationExitInfo is constructed or reflected here.
 */
class AnrHelpersTest {
  private val readTraceMethod =
    AutoMobileAnr::class
      .java
      .getDeclaredMethod(
        "readCappedAnrTrace",
        InputStream::class.java,
        Int::class.javaPrimitiveType,
      )
      .apply { isAccessible = true }

  private val cursorClass =
    AutoMobileAnr::class.java.declaredClasses.single { it.simpleName == "AnrCursor" }
  private val cursorConstructor =
    cursorClass.getDeclaredConstructor(Long::class.javaPrimitiveType, Set::class.java).apply {
      isAccessible = true
    }

  private fun cursor(timestamp: Long, idsAtTimestamp: Set<String>? = null): Any =
    cursorConstructor.newInstance(timestamp, idsAtTimestamp)

  private val reportMethod =
    AutoMobileAnr::class
      .java
      .getDeclaredMethod(
        "reportNewAnrs",
        List::class.java,
        Function1::class.java,
        Function1::class.java,
        cursorClass,
        Function1::class.java,
      )
      .apply { isAccessible = true }

  private fun readTrace(stream: InputStream?, cap: Int = TRACE_CAP): String? =
    readTraceMethod.invoke(AutoMobileAnr, stream, cap) as String?

  private fun marker(cap: Int = TRACE_CAP) = "\n(truncated — trace capped at $cap chars)\n"

  private fun report(
    items: List<Long>,
    lastReported: Long = 0L,
    send: (Long) -> Boolean,
  ): Any {
    val timestampOf: (Long) -> Long = { it }
    val identityOf: (Long) -> String = { it.toString() }
    return reportMethod.invoke(
      AutoMobileAnr,
      items,
      timestampOf,
      identityOf,
      cursor(lastReported),
      send,
    )
  }

  @Test
  fun `five megabyte trace is capped with a truncation marker`() {
    val bytes = ByteArray(5 * 1024 * 1024).apply { fill('x'.code.toByte()) }
    val trace = readTrace(ByteArrayInputStream(bytes))!!

    assertEquals(TRACE_CAP + marker().length, trace.length)
    assertTrue(trace.endsWith(marker()))
  }

  @Test
  fun `trace exactly at the cap has no marker`() {
    val text = "x".repeat(TRACE_CAP)

    assertEquals(text, readTrace(ByteArrayInputStream(text.toByteArray(Charsets.UTF_8))))
  }

  @Test
  fun `small trace is unchanged`() {
    val text = "main thread\n  at Example.run(Example.kt:1)\n"

    assertEquals(text, readTrace(ByteArrayInputStream(text.toByteArray(Charsets.UTF_8))))
  }

  @Test
  fun `empty stream returns empty text`() {
    assertEquals("", readTrace(ByteArrayInputStream(byteArrayOf())))
  }

  @Test
  fun `null stream returns null`() {
    assertNull(readTrace(null))
  }

  @Test
  fun `multibyte UTF-8 is decoded and capped by characters`() {
    val text = "é漢🙂".repeat(100)
    val cap = 32

    assertEquals(
      text.take(cap) + marker(cap),
      readTrace(ByteArrayInputStream(text.toByteArray(Charsets.UTF_8)), cap),
    )
  }

  @Test
  fun `trace stream is closed`() {
    val stream = CountingInputStream("trace".toByteArray(Charsets.UTF_8))

    assertEquals("trace", readTrace(stream))
    assertTrue(stream.closed)
  }

  @Test
  fun `large stream is not read in full and is closed after truncation`() {
    val stream = CountingInputStream(ByteArray(5 * 1024 * 1024).apply { fill('x'.code.toByte()) })

    assertTrue(readTrace(stream)!!.endsWith(marker()))
    assertTrue(stream.bytesRead < TRACE_CAP * 4 + 8192)
    assertTrue(stream.closed)
  }

  @Test
  fun `zero cap probes for content without returning trace characters`() {
    assertEquals(marker(0), readTrace(ByteArrayInputStream(byteArrayOf(120)), 0))
    assertEquals("", readTrace(ByteArrayInputStream(byteArrayOf()), 0))
  }

  @Test
  fun `all successful ANRs are sent oldest first and advance to newest`() {
    val sent = mutableListOf<Long>()

    val watermark =
      report(listOf(30L, 10L, 20L)) {
        sent.add(it)
        true
      }

    assertEquals(listOf(10L, 20L, 30L), sent)
    assertEquals(cursor(30L, setOf("30")), watermark)
  }

  @Test
  fun `failure on oldest ANR preserves watermark and stops later sends`() {
    val sent = mutableListOf<Long>()

    val watermark =
      report(listOf(30L, 20L, 10L), lastReported = 5L) {
        sent.add(it)
        false
      }

    assertEquals(listOf(10L), sent)
    assertEquals(cursor(5L), watermark)
  }

  @Test
  fun `failure in the middle advances only through the preceding success`() {
    val sent = mutableListOf<Long>()

    val watermark =
      report(listOf(30L, 20L, 10L)) {
        sent.add(it)
        it != 20L
      }

    assertEquals(listOf(10L, 20L), sent)
    assertEquals(cursor(10L, setOf("10")), watermark)
  }

  @Test
  fun `already reported ANRs are skipped including the watermark boundary`() {
    val sent = mutableListOf<Long>()

    val watermark =
      report(listOf(30L, 20L, 10L), lastReported = 20L) {
        sent.add(it)
        true
      }

    assertEquals(listOf(30L), sent)
    assertEquals(cursor(30L, setOf("30")), watermark)
  }

  @Test
  fun `empty history preserves watermark without sending`() {
    var sent = false

    val watermark =
      report(emptyList(), lastReported = 20L) {
        sent = true
        true
      }

    assertEquals(cursor(20L), watermark)
    assertFalse(sent)
  }

  private class CountingInputStream(bytes: ByteArray) : ByteArrayInputStream(bytes) {
    var bytesRead = 0
      private set

    var closed = false
      private set

    override fun read(): Int {
      val value = super.read()
      if (value != -1) bytesRead++
      return value
    }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
      val count = super.read(buffer, offset, length)
      if (count > 0) bytesRead += count
      return count
    }

    override fun close() {
      closed = true
      super.close()
    }
  }

  private companion object {
    const val TRACE_CAP = 200_000
  }
}
