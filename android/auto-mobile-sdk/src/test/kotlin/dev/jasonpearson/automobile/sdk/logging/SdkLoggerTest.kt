package dev.jasonpearson.automobile.sdk.logging

import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.junit.Test

class SdkLoggerTest {

  @Test
  fun `FakeSdkLogger records debug log`() {
    val logger = FakeSdkLogger()
    logger.d("MyTag") { "hello" }
    assertEquals(1, logger.entries.size)
    val entry = logger.entries.first()
    assertEquals("D", entry.level)
    assertEquals("MyTag", entry.tag)
    assertEquals("hello", entry.message)
    assertNull(entry.throwable)
  }

  @Test
  fun `FakeSdkLogger records info log`() {
    val logger = FakeSdkLogger()
    logger.i("Tag") { "info message" }
    assertEquals("I", logger.entries.first().level)
  }

  @Test
  fun `FakeSdkLogger records warning with throwable`() {
    val logger = FakeSdkLogger()
    val ex = RuntimeException("boom")
    logger.w("Tag", ex) { "warn" }
    val entry = logger.entries.first()
    assertEquals("W", entry.level)
    assertEquals("warn", entry.message)
    assertEquals(ex, entry.throwable)
  }

  @Test
  fun `FakeSdkLogger records warning without throwable`() {
    val logger = FakeSdkLogger()
    logger.w("Tag") { "warn no throwable" }
    val entry = logger.entries.first()
    assertEquals("W", entry.level)
    assertNull(entry.throwable)
  }

  @Test
  fun `FakeSdkLogger records error with throwable`() {
    val logger = FakeSdkLogger()
    val ex = IllegalStateException("bad")
    logger.e("Tag", ex) { "error" }
    val entry = logger.entries.first()
    assertEquals("E", entry.level)
    assertEquals(ex, entry.throwable)
  }

  @Test
  fun `FakeSdkLogger clear removes all entries`() {
    val logger = FakeSdkLogger()
    logger.d("A") { "1" }
    logger.d("B") { "2" }
    assertEquals(2, logger.entries.size)
    logger.clear()
    assertTrue(logger.entries.isEmpty())
  }

  @Test
  fun `NoOpSdkLogger does not evaluate message lambda`() {
    var evaluated = false
    NoOpSdkLogger.d("Tag") {
      evaluated = true
      "msg"
    }
    assertTrue(!evaluated, "NoOpSdkLogger should not evaluate the message lambda")
  }

  @Test
  fun `NoOpSdkLogger warning does not evaluate message lambda`() {
    var evaluated = false
    NoOpSdkLogger.w("Tag", RuntimeException()) {
      evaluated = true
      "msg"
    }
    assertTrue(!evaluated)
  }

  @Test
  fun `NoOpSdkLogger error does not evaluate message lambda`() {
    var evaluated = false
    NoOpSdkLogger.e("Tag", RuntimeException()) {
      evaluated = true
      "msg"
    }
    assertTrue(!evaluated)
  }

  @Test
  fun `FakeSdkLogger entries returns snapshot`() {
    val logger = FakeSdkLogger()
    logger.d("T") { "a" }
    val snapshot = logger.entries
    logger.d("T") { "b" }
    // snapshot is a copy, should not contain "b"
    assertEquals(1, snapshot.size)
    assertEquals(2, logger.entries.size)
  }
}
