package dev.jasonpearson.automobile.ctrlproxy

import java.security.MessageDigest
import java.util.Locale
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class GeneratedViewIdTest {
  @Test
  fun `generated ids match the original formula and UUID shape`() {
    val shape = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
    for (path in equalityPaths) {
      val actual = GeneratedViewId.fromPath(path)
      assertEquals(originalId(path), actual)
      assertTrue("Invalid generated id: $actual", shape.matches(actual))
    }
  }

  @Test
  fun `digest reuse stays independent across threads and successive paths`() {
    val expected = paths.map(::originalId)
    val executor = Executors.newFixedThreadPool(4)
    val start = CountDownLatch(1)
    try {
      val results =
        List(4) {
          executor.submit<List<String>> {
            check(start.await(10, TimeUnit.SECONDS))
            paths.map(GeneratedViewId::fromPath)
          }
        }
      start.countDown()
      results.forEach { assertEquals(expected, it.get(10, TimeUnit.SECONDS)) }
    } finally {
      executor.shutdownNow()
    }
  }

  private fun originalId(path: String): String {
    val bytes = MessageDigest.getInstance("SHA-256").digest(path.toByteArray())
    val hex = bytes.take(16).joinToString("") { "%02x".format(Locale.ROOT, it) }
    return "${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20, 32)}"
  }

  private val paths =
    listOf("", "root", "root/0/1", "根/子/🙂/é", "e\u0301", "a\u0000b", "root/".repeat(4096)) +
      List(320) { index -> "window[${index % 7}]/root/$index/子/${index * 31}/🙂" }

  /** The equality check covers 10,000 paths; the concurrent test keeps the smaller set. */
  private val equalityPaths =
    paths + List(10_000 - paths.size) { index -> "window[${index % 11}]/root/${index / 97}/$index" }
}
