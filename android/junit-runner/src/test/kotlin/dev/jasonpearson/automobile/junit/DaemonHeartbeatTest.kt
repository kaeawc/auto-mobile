package dev.jasonpearson.automobile.junit

import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
    val sleepIntervals = mutableListOf<Long>()
    val threadNames = mutableListOf<String>()
    val runnables = mutableListOf<Runnable>()
    var onSleep: () -> Unit = { throw AssertionError("Unexpected sleep") }
    val manager =
      BackgroundHeartbeatManager(
        sendHeartbeat = { sentSessions.add(it) },
        sleeper = {
          sleepIntervals.add(it)
          assertTrue("Loop must stop deterministically", sleepIntervals.size <= 3)
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
