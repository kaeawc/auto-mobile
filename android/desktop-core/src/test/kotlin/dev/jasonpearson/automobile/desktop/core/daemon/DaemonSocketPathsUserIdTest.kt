package dev.jasonpearson.automobile.desktop.core.daemon

import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.Test
import kotlin.test.assertEquals

/** #10238: the uid is resolved once per process, never per path lookup, and not for overrides. */
class DaemonSocketPathsUserIdTest {
  private val noEnv: (String) -> String? = { null }

  private fun env(vararg pairs: Pair<String, String>): (String) -> String? = mapOf(*pairs)::get

  @Test
  fun `many socket and pid path lookups resolve the uid once`() {
    val lookups = AtomicInteger()
    val userId = CachedDaemonUserId { "501".also { lookups.incrementAndGet() } }

    repeat(25) {
      assertEquals("/tmp/auto-mobile-daemon-501.sock", DaemonSocketPaths.socketPath(userId, noEnv))
      assertEquals("/tmp/auto-mobile-daemon-501.pid", DaemonSocketPaths.pidFilePath(userId, noEnv))
    }

    assertEquals(1, lookups.get())
  }

  @Test
  fun `an explicit path override skips the uid lookup`() {
    val lookups = AtomicInteger()
    val userId = CachedDaemonUserId { "501".also { lookups.incrementAndGet() } }

    assertEquals(
      "/run/am.sock",
      DaemonSocketPaths.socketPath(userId, env("AUTOMOBILE_DAEMON_SOCKET_PATH" to "/run/am.sock")),
    )
    assertEquals(
      "/run/am.pid",
      DaemonSocketPaths.pidFilePath(
        userId,
        env("AUTOMOBILE_DAEMON_PID_FILE_PATH" to "/run/am.pid"),
      ),
    )
    assertEquals(0, lookups.get())

    // A blank override is no override: the default path pays for the (single) lookup.
    assertEquals(
      "/tmp/auto-mobile-daemon-501.sock",
      DaemonSocketPaths.socketPath(userId, env("AUTOMOBILE_DAEMON_SOCKET_PATH" to "  ")),
    )
    assertEquals(1, lookups.get())
  }

  @Test
  fun `concurrent first callers share one lookup`() {
    val lookups = AtomicInteger()
    val userId = CachedDaemonUserId { "501".also { lookups.incrementAndGet() } }
    val start = CountDownLatch(1)
    val pool = Executors.newFixedThreadPool(8)
    try {
      val results =
        List(8) {
          pool.submit<String> {
            start.await()
            userId.value
          }
        }
      start.countDown()
      assertEquals(List(8) { "501" }, results.map { it.get(5, TimeUnit.SECONDS) })
    } finally {
      pool.shutdownNow()
    }

    assertEquals(1, lookups.get())
  }

  @Test
  fun `a failed or empty uid read falls back to the user name and is cached`() {
    val reads = AtomicInteger()
    val failing = CachedDaemonUserId {
      resolveDaemonUserId("jason", "mac os x") {
        reads.incrementAndGet()
        error("id not found")
      }
    }
    repeat(3) { assertEquals("jason", failing.value) }
    assertEquals(1, reads.get())

    assertEquals("jason", resolveDaemonUserId("jason", "linux") { "  \n" })
    assertEquals("jason", resolveDaemonUserId("jason", "linux") { "" })
  }

  @Test
  fun `a successful uid read is trimmed and Windows uses the user name without reading`() {
    assertEquals("1000", resolveDaemonUserId("jason", "linux") { "1000\n" })
    assertEquals(
      "jason",
      resolveDaemonUserId("jason", "windows 11") { error("must not read the uid on Windows") },
    )
  }
}
