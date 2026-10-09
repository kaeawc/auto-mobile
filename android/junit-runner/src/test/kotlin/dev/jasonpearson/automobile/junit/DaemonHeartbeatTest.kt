package dev.jasonpearson.automobile.junit

import com.sun.net.httpserver.HttpServer
import java.net.InetAddress
import java.net.InetSocketAddress
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class DaemonHeartbeatTest {
  @Test
  fun `double close keeps the other holder and heartbeat loop alive`() {
    val fake = HeartbeatFake()
    val h1 = fake.manager.start(25L)
    val h2 = fake.manager.start(25L)
    fake.manager.addSession("s1")

    h1.close()
    h1.close()

    assertTrue(fake.manager.isRunning)
    assertEquals(1, fake.manager.holderCount)
    assertEquals(listOf("auto-mobile-daemon-heartbeat"), fake.threadNames)
    fake.onSleep = {
      assertTrue(fake.manager.isRunning)
      assertEquals(1, fake.manager.holderCount)
      if (fake.sleepIntervals.size == 3) h2.close()
    }
    fake.runnables.single().run()

    assertEquals(listOf(25L, 25L, 25L), fake.sleepIntervals)
    assertEquals(listOf("s1", "s1", "s1"), fake.sentSessions)
    assertFalse(fake.manager.isRunning)
    assertEquals(0, fake.manager.holderCount)
  }

  @Test
  fun `a 404 heartbeat records the daemon's reason and stops heartbeating the session`() {
    val fake = HeartbeatFake()
    fake.onSend = { sessionId ->
      if (sessionId == "lost") {
        throw DaemonSessionReleasedException(sessionId, "idle", "Session not found: lost")
      }
    }
    val handle = fake.manager.start(10L)
    fake.manager.addSession("lost")
    fake.manager.addSession("live")
    fake.onSleep = { if (fake.sleepIntervals.size == 2) handle.close() }

    fake.runnables.single().run()

    assertEquals(
      DaemonSessionLoss("lost", "idle", "Session not found: lost"),
      fake.manager.sessionLoss("lost"),
    )
    assertNull(fake.manager.sessionLoss("live"))
    assertEquals("the released session is sent once", 1, fake.sentSessions.count { it == "lost" })
    assertEquals(2, fake.sentSessions.count { it == "live" })

    // A released UUID is terminal: registering it again (recovery) never heartbeats it.
    fake.manager.addSession("lost")
    fake.sentSessions.clear()
    val again = fake.manager.start(10L)
    fake.onSleep = { again.close() }
    fake.runnables.last().run()
    assertFalse(fake.sentSessions.contains("lost"))
  }

  @Test
  fun `a bare 404 before any successful heartbeat keeps heartbeating`() {
    val fake = HeartbeatFake()
    fake.onSend = { sessionId ->
      if (fake.sentSessions.size <= 3) {
        throw DaemonSessionReleasedException(sessionId, null, "Session not found")
      }
    }
    fake.maxSleeps = 5
    val handle = fake.manager.start(10L)
    fake.manager.addSession("new")
    fake.onSleep = { if (fake.sleepIntervals.size == 5) handle.close() }

    fake.runnables.single().run()

    assertEquals(5, fake.sentSessions.size)
    assertNull(fake.manager.sessionLoss("new"))
  }

  @Test
  fun `a bare 404 after a successful heartbeat is a confirmed loss`() {
    val fake = HeartbeatFake()
    fake.onSend = { sessionId ->
      if (fake.sentSessions.size > 1) {
        throw DaemonSessionReleasedException(sessionId, null, "Session not found")
      }
    }
    val handle = fake.manager.start(10L)
    fake.manager.addSession("s1")
    fake.onSleep = { if (fake.sleepIntervals.size == 3) handle.close() }

    fake.runnables.single().run()

    assertEquals(2, fake.sentSessions.size)
    assertEquals(true, fake.manager.sessionLoss("s1")?.confirmed)
  }

  @Test
  fun `a never-acknowledged id gives up after a bounded number of 404s as unconfirmed`() {
    val fake = HeartbeatFake()
    fake.onSend = { throw DaemonSessionReleasedException(it, null, "Session not found") }
    fake.maxSleeps = 40
    val handle = fake.manager.start(10L)
    fake.manager.addSession("ghost")
    fake.onSleep = { if (fake.sleepIntervals.size == 40) handle.close() }

    fake.runnables.single().run()

    assertEquals(30, fake.sentSessions.size)
    assertEquals(false, fake.manager.sessionLoss("ghost")?.confirmed)
  }

  @Test
  fun `a transient heartbeat failure keeps the session heartbeating`() {
    val fake = HeartbeatFake()
    fake.onSend = { throw java.io.IOException("connection refused") }
    val handle = fake.manager.start(10L)
    fake.manager.addSession("s1")
    fake.onSleep = { if (fake.sleepIntervals.size == 2) handle.close() }

    fake.runnables.single().run()

    assertEquals(listOf("s1", "s1"), fake.sentSessions)
    assertNull(fake.manager.sessionLoss("s1"))
  }

  @Test
  fun `the http heartbeat maps a 404 to the daemon's release reason`() {
    withHeartbeatServer(
      404,
      """{"error":"Session not found: s1","releaseReason":"heartbeat-timeout"}""",
    ) { url ->
      val error =
        assertThrows(DaemonSessionReleasedException::class.java) {
          DaemonHeartbeat.sendHeartbeat(url, "s1")
        }
      assertEquals("s1", error.sessionId)
      assertEquals("heartbeat-timeout", error.releaseReason)
      assertEquals("Session not found: s1", error.message)
    }
    withHeartbeatServer(404, """{"error":"Session not found: s2"}""") { url ->
      val error =
        assertThrows(DaemonSessionReleasedException::class.java) {
          DaemonHeartbeat.sendHeartbeat(url, "s2")
        }
      assertNull(error.releaseReason)
    }
    withHeartbeatServer(200, """{"status":"ok"}""") { url ->
      DaemonHeartbeat.sendHeartbeat(url, "s3")
    }
    withHeartbeatServer(500, """{"error":"boom"}""") { url ->
      assertThrows(java.io.IOException::class.java) { DaemonHeartbeat.sendHeartbeat(url, "s4") }
    }
  }

  private fun withHeartbeatServer(status: Int, body: String, block: (java.net.URL) -> Unit) {
    val server = HttpServer.create(InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0)
    server.createContext("/heartbeat") { exchange ->
      exchange.requestBody.use { it.readBytes() }
      val bytes = body.toByteArray()
      exchange.sendResponseHeaders(status, bytes.size.toLong())
      exchange.responseBody.use { it.write(bytes) }
    }
    server.start()
    try {
      block(java.net.URL("http://127.0.0.1:${server.address.port}/heartbeat"))
    } finally {
      server.stop(0)
    }
  }

  @Test
  fun `last close stops the active loop`() {
    val fake = HeartbeatFake()
    val handle = fake.manager.start(10L)
    fake.manager.addSession("s1")
    fake.onSleep = { handle.close() }

    fake.runnables.single().run()

    assertFalse(fake.manager.isRunning)
    assertEquals(0, fake.manager.holderCount)
    assertEquals(listOf(10L), fake.sleepIntervals)
    assertEquals(listOf("s1"), fake.sentSessions)
  }

  @Test
  fun `closing both holders once stops the loop`() {
    val fake = HeartbeatFake()
    val h1 = fake.manager.start(10L)
    val h2 = fake.manager.start(10L)
    fake.manager.addSession("s1")

    h1.close()
    assertTrue(fake.manager.isRunning)
    assertEquals(1, fake.manager.holderCount)
    h2.close()
    fake.runnables.single().run()

    assertFalse(fake.manager.isRunning)
    assertEquals(0, fake.manager.holderCount)
    assertTrue(fake.sentSessions.isEmpty())
    assertTrue(fake.sleepIntervals.isEmpty())
  }

  @Test
  fun `start after full stop creates a fresh thread and keeps the old loop stopped`() {
    val fake = HeartbeatFake()
    val first = fake.manager.start(10L)
    fake.manager.addSession("s1")
    first.close()

    val second = fake.manager.start(20L)

    assertEquals(2, fake.runnables.size)
    assertTrue(fake.manager.isRunning)
    assertEquals(1, fake.manager.holderCount)
    fake.runnables.first().run()
    assertTrue(fake.sentSessions.isEmpty())
    fake.onSleep = { second.close() }
    fake.runnables.last().run()
    assertEquals(listOf(20L), fake.sleepIntervals)
    assertEquals(listOf("s1"), fake.sentSessions)
    assertFalse(fake.manager.isRunning)
    assertEquals(0, fake.manager.holderCount)
  }

  @Test
  fun `reclosing a stopped handle never decrements a later holder`() {
    val fake = HeartbeatFake()
    val first = fake.manager.start(10L)
    first.close()
    first.close()

    assertEquals(0, fake.manager.holderCount)
    assertFalse(fake.manager.isRunning)
    val second = fake.manager.start(10L)
    first.close()
    assertEquals(1, fake.manager.holderCount)
    assertTrue(fake.manager.isRunning)
    second.close()
    second.close()
    assertEquals(0, fake.manager.holderCount)
    assertFalse(fake.manager.isRunning)
    fake.runnables.forEach { it.run() }
    assertTrue(fake.sleepIntervals.isEmpty())
  }

  @Test
  fun `uid and pid path cache the trimmed command result`() {
    val commands = mutableListOf<List<String>>()
    val resolver =
      DaemonUserIdResolver(
        envProvider = { null },
        osName = { "Linux" },
        userName = { throw AssertionError("Successful UID must not use the fallback") },
        runCommand = {
          commands.add(it)
          "  501\n"
        },
      )

    repeat(50) {
      assertEquals("501", resolver.userId)
      assertEquals("/tmp/auto-mobile-daemon-501.pid", resolver.pidPath())
    }
    assertEquals(listOf(listOf("id", "-u")), commands)
  }

  @Test
  fun `blank command result retries and caches the successful uid`() {
    assertRetriesAfterFailure(" \n")
  }

  @Test
  fun `failed command retries and caches the successful uid`() {
    assertRetriesAfterFailure(null)
  }

  @Test
  fun `concurrent first calls cache one successful uid resolution`() {
    val threadCount = 8
    val ready = CountDownLatch(threadCount)
    val start = CountDownLatch(1)
    val commandCalls = AtomicInteger()
    val results = ConcurrentLinkedQueue<String>()
    val failures = ConcurrentLinkedQueue<Throwable>()
    val resolver =
      DaemonUserIdResolver(
        osName = { "Linux" },
        userName = { throw AssertionError("Successful UID must not use the fallback") },
        runCommand = {
          commandCalls.incrementAndGet()
          "501"
        },
      )
    val threads =
      List(threadCount) {
        thread(isDaemon = true) {
          try {
            ready.countDown()
            assertTrue("Start gate must open", start.await(5, TimeUnit.SECONDS))
            results.add(resolver.userId)
          } catch (failure: Throwable) {
            failures.add(failure)
          }
        }
      }

    try {
      assertTrue("Workers must reach the start gate", ready.await(5, TimeUnit.SECONDS))
    } finally {
      start.countDown()
      threads.forEach { it.join(5000) }
    }

    threads.forEach { assertFalse("Worker must finish", it.isAlive) }
    failures.peek()?.let { throw AssertionError("UID resolution thread failed", it) }
    assertEquals(threadCount, results.size)
    results.forEach { assertEquals("501", it) }
    assertEquals(1, commandCalls.get())
  }

  @Test
  fun `Windows caches the user name without running a command`() {
    var userNameCalls = 0
    val resolver =
      DaemonUserIdResolver(
        envProvider = { null },
        osName = { "Windows 11" },
        userName = {
          userNameCalls++
          "windows-user"
        },
        runCommand = { throw AssertionError("Windows must not run id") },
      )

    repeat(50) {
      assertEquals("windows-user", resolver.userId)
      assertEquals("/tmp/auto-mobile-daemon-windows-user.pid", resolver.pidPath())
    }
    assertEquals(1, userNameCalls)
  }

  private fun assertRetriesAfterFailure(firstCommandResult: String?) {
    var commandCalls = 0
    var userNameCalls = 0
    val resolver =
      DaemonUserIdResolver(
        osName = { "Linux" },
        userName = {
          userNameCalls++
          "fallback-user"
        },
        runCommand = {
          assertEquals(listOf("id", "-u"), it)
          commandCalls++
          if (commandCalls == 1) firstCommandResult else "501"
        },
      )

    assertEquals("/tmp/auto-mobile-daemon-fallback-user.pid", resolver.pidPath())
    assertEquals(1, commandCalls)
    assertEquals(1, userNameCalls)
    assertEquals("501", resolver.userId)
    repeat(50) {
      assertEquals("501", resolver.userId)
      assertEquals("/tmp/auto-mobile-daemon-501.pid", resolver.pidPath())
    }
    assertEquals(2, commandCalls)
    assertEquals(1, userNameCalls)
  }

  private class HeartbeatFake {
    val sentSessions = mutableListOf<String>()
    var onSend: (String) -> Unit = {}
    val sleepIntervals = mutableListOf<Long>()
    val threadNames = mutableListOf<String>()
    val runnables = mutableListOf<Runnable>()
    var maxSleeps = 3
    var onSleep: () -> Unit = { throw AssertionError("Unexpected sleep") }
    val manager =
      BackgroundHeartbeatManager(
        sendHeartbeat = {
          sentSessions.add(it)
          onSend(it)
        },
        sleeper = {
          sleepIntervals.add(it)
          assertTrue("Loop must stop deterministically", sleepIntervals.size <= maxSleeps)
          onSleep()
        },
        threadFactory = { name, runnable ->
          threadNames.add(name)
          runnables.add(runnable)
          Thread(runnable, name)
        },
      )
  }
}
