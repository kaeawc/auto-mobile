package dev.jasonpearson.automobile.ctrlproxy.prototype

import kotlinx.coroutines.CancellationException
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

internal class FakePinnedShortcutPlatform : PinnedShortcutPlatform {
  var supported = true
  var pinned = emptySet<String>()
  var accepted = true
  var updated = true
  var readFailure: Exception? = null
  var requestFailure: Exception? = null
  var updateFailure: Exception? = null
  val requests = mutableListOf<PrototypeShortcut>()
  val updates = mutableListOf<PrototypeShortcut>()

  override fun isRequestPinSupported() = supported

  override fun pinnedIds(): Set<String> {
    readFailure?.let { throw it }
    return pinned
  }

  override fun requestPin(shortcut: PrototypeShortcut): Boolean {
    requestFailure?.let { throw it }
    requests += shortcut
    return accepted
  }

  override fun update(shortcut: PrototypeShortcut): Boolean {
    updateFailure?.let { throw it }
    updates += shortcut
    return updated
  }
}

class PinnedPrototypeShortcutsTest {
  private val platform = FakePinnedShortcutPlatform()
  private val pinner = PinnedPrototypeShortcuts(platform)

  @Test
  fun `unsupported launcher never requests pin`() {
    platform.supported = false
    assertTrue(pinner.pin("panel", "Panel", null) is PinOutcome.Unsupported)
    assertTrue(platform.requests.isEmpty())
  }

  @Test
  fun `new pin carries id bounded trimmed labels and icon`() {
    val bytes = byteArrayOf(1)
    assertEquals(PinOutcome.Requested, pinner.pin("panel", "  ABCDEFGHIJKLMNOPQRSTUVWXYZ  ", bytes))
    val shortcut = platform.requests.single()
    assertEquals(shortcutIdFor("panel"), shortcut.id)
    assertEquals("ABCDEFGHIJ", shortcut.shortLabel)
    assertEquals("ABCDEFGHIJKLMNOPQRSTUVWXY", shortcut.longLabel)
    assertArrayEquals(bytes, shortcut.iconBytes)
    assertEquals("panel", shortLabelFor(" \n ", "panel"))
    assertEquals("panel", longLabelFor("", "panel"))
  }

  @Test
  fun `already pinned updates instead of requesting even when rate limited`() {
    platform.pinned = setOf("panel")
    assertEquals(PinOutcome.AlreadyPinned(ShortcutUpdate.UPDATED), pinner.pin("panel", "New", null))
    platform.updated = false
    assertEquals(
      PinOutcome.AlreadyPinned(ShortcutUpdate.RATE_LIMITED),
      pinner.pin("panel", "New", null),
    )
    assertEquals(2, platform.updates.size)
    assertTrue(platform.requests.isEmpty())
  }

  @Test
  fun `launcher refusals and exceptions become typed outcomes`() {
    platform.accepted = false
    assertEquals(
      PinOutcome.Failed("Launcher refused the pin request"),
      pinner.pin("panel", "Panel", null),
    )
    platform.requestFailure = IllegalStateException("locked")
    assertTrue(
      (pinner.pin("panel", "Panel", null) as PinOutcome.DeviceLocked).message.contains("unlock"),
    )
    platform.requestFailure = IllegalArgumentException("bad launcher")
    assertEquals(PinOutcome.Failed("bad launcher"), pinner.pin("panel", "Panel", null))
    platform.readFailure = Exception()
    assertEquals(PinOutcome.Failed("Exception"), pinner.pin("panel", "Panel", null))
  }

  @Test
  fun `update is best effort and preserves rate limiting`() {
    assertNull(pinner.updateIfPinned("panel", "Panel", null))
    platform.pinned = setOf("panel")
    assertEquals(ShortcutUpdate.UPDATED, pinner.updateIfPinned("panel", "Panel", null))
    platform.updated = false
    assertEquals(ShortcutUpdate.RATE_LIMITED, pinner.updateIfPinned("panel", "Panel", null))
    platform.updateFailure = Exception("update")
    assertNull(pinner.updateIfPinned("panel", "Panel", null))
    platform.readFailure = Exception("read")
    assertNull(pinner.updateIfPinned("panel", "Panel", null))
  }

  @Test
  fun `cancellation propagates from pin and update`() {
    platform.readFailure = CancellationException("cancelled")
    assertThrows(CancellationException::class.java) { pinner.pin("panel", "Panel", null) }
    assertThrows(CancellationException::class.java) {
      pinner.updateIfPinned("panel", "Panel", null)
    }
    platform.readFailure = null
    platform.requestFailure = CancellationException("cancelled")
    assertThrows(CancellationException::class.java) { pinner.pin("panel", "Panel", null) }
    platform.pinned = setOf("panel")
    platform.updateFailure = CancellationException("cancelled")
    assertThrows(CancellationException::class.java) {
      pinner.updateIfPinned("panel", "Panel", null)
    }
  }
}
