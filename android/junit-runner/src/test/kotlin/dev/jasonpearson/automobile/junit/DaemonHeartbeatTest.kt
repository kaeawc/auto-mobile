package dev.jasonpearson.automobile.junit

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
  fun `blank command result caches the user name fallback`() {
    assertCachedFallback(" \n")
  }

  @Test
  fun `failed command caches the user name fallback`() {
    assertCachedFallback(null)
  }

  @Test
  fun `Windows caches the user name without running a command`() {
    var userNameCalls = 0
    val resolver =
      DaemonUserIdResolver(
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

  private fun assertCachedFallback(commandResult: String?) {
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
          commandResult
        },
      )

    repeat(50) {
      assertEquals("fallback-user", resolver.userId)
      assertEquals("/tmp/auto-mobile-daemon-fallback-user.pid", resolver.pidPath())
    }
    assertEquals(1, commandCalls)
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
