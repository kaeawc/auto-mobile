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
  var enableFailure: Exception? = null
  val disabled = mutableSetOf<String>()
  val enabled = mutableListOf<PrototypeShortcut>()
  val iconBytes = mutableMapOf<String, ByteArray>()
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
    if (accepted) shortcut.iconBytes?.let { iconBytes[shortcut.id] = it }
    return accepted
  }

  override fun enable(shortcut: PrototypeShortcut) {
    enableFailure?.let { throw it }
    enabled += shortcut
    disabled -= shortcut.id
  }

  override fun update(shortcut: PrototypeShortcut): Boolean {
    updateFailure?.let { throw it }
    check(shortcut.id !in disabled) { "Shortcut must be enabled before updating" }
    updates += shortcut
    if (updated) shortcut.iconBytes?.let { iconBytes[shortcut.id] = it }
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
  fun `pin after delete re enables and updates instead of requesting even when rate limited`() {
    platform.pinned = setOf("panel")
    platform.disabled += "panel"
    assertEquals(PinOutcome.AlreadyPinned(ShortcutUpdate.UPDATED), pinner.pin("panel", "New", null))
    platform.updated = false
    assertEquals(
      PinOutcome.AlreadyPinned(ShortcutUpdate.RATE_LIMITED),
      pinner.pin("panel", "New", null),
    )
    assertEquals(2, platform.updates.size)
    assertEquals(listOf("panel", "panel"), platform.enabled.map { it.id })
    assertEquals("New", platform.enabled.first().shortLabel)
    assertEquals("New", platform.enabled.first().longLabel)
    assertEquals(platform.updates, platform.enabled)
    assertTrue(platform.disabled.isEmpty())
    assertNull(platform.updates.first().iconBytes)
    assertTrue(platform.requests.isEmpty())
  }

  @Test
  fun `label limits never split a surrogate pair`() {
    assertEquals("a".repeat(9), shortLabelFor("a".repeat(9) + "😀tail", "panel"))
    assertEquals("a".repeat(24), longLabelFor("a".repeat(24) + "😀tail", "panel"))
    assertEquals("a".repeat(8) + "😀", shortLabelFor("a".repeat(8) + "😀tail", "panel"))
    assertEquals("a".repeat(23) + "😀", longLabelFor("a".repeat(23) + "😀tail", "panel"))
  }

  @Test
  fun `null icon preserves the pinned icon on both update paths`() {
    val original = byteArrayOf(1)
    val replacement = byteArrayOf(2)
    platform.pinned = setOf("panel")
    platform.iconBytes["panel"] = original
    assertEquals(PinOutcome.AlreadyPinned(ShortcutUpdate.UPDATED), pinner.pin("panel", "New", null))
    assertArrayEquals(original, platform.iconBytes["panel"])
    assertEquals(ShortcutUpdate.UPDATED, pinner.updateIfPinned("panel", "Saved", null))
    assertArrayEquals(original, platform.iconBytes["panel"])
    assertEquals(ShortcutUpdate.UPDATED, pinner.updateIfPinned("panel", "Saved", replacement))
    assertArrayEquals(replacement, platform.iconBytes["panel"])
  }

  @Test
  fun `only request pin illegal state means device locked`() {
    platform.readFailure = IllegalStateException("read failed")
    assertEquals(PinOutcome.Failed("read failed"), pinner.pin("panel", "Panel", null))
    platform.readFailure = null
    platform.pinned = setOf("panel")
    platform.enableFailure = IllegalStateException("enable failed")
    assertEquals(PinOutcome.Failed("enable failed"), pinner.pin("panel", "Panel", null))
    assertNull(pinner.updateIfPinned("panel", "Panel", null))
    assertTrue(platform.updates.isEmpty())
    platform.enableFailure = null
    platform.updateFailure = IllegalStateException("update failed")
    assertEquals(PinOutcome.Failed("update failed"), pinner.pin("panel", "Panel", null))
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
    platform.disabled += "panel"
    assertEquals(ShortcutUpdate.UPDATED, pinner.updateIfPinned("panel", "Panel", null))
    assertTrue(platform.disabled.isEmpty())
    assertEquals(listOf("panel"), platform.enabled.map { it.id })
    assertEquals(platform.updates, platform.enabled)
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
    platform.enableFailure = CancellationException("cancelled")
    assertThrows(CancellationException::class.java) { pinner.pin("panel", "Panel", null) }
    assertThrows(CancellationException::class.java) {
      pinner.updateIfPinned("panel", "Panel", null)
    }
    platform.enableFailure = null
    platform.updateFailure = CancellationException("cancelled")
    assertThrows(CancellationException::class.java) {
      pinner.updateIfPinned("panel", "Panel", null)
    }
  }
}
