package dev.jasonpearson.automobile.prototype.appshell

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test

class AppShellLinkInboxTest {
  @Test
  fun `cold URL executes before first frame and warm URLs execute immediately`() = runBlocking {
    val order = mutableListOf<String>()
    val inbox = AppShellLinkInbox()
    inbox.receive("cold")
    inbox.attach { order += it }
    order += "first frame"
    inbox.receive("warm")
    assertEquals(listOf("cold", "first frame", "warm"), order)
  }
}
