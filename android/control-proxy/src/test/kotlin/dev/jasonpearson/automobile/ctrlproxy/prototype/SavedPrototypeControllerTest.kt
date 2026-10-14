package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeResult
import dev.jasonpearson.automobile.protocol.PrototypeSpec
import dev.jasonpearson.automobile.protocol.SavedPrototypeEntry
import dev.jasonpearson.automobile.protocol.SavedPrototypeErrorCode
import dev.jasonpearson.automobile.protocol.SavedPrototypeInfo
import dev.jasonpearson.automobile.protocol.SavedPrototypePinInfo
import dev.jasonpearson.automobile.protocol.SavedPrototypePinStatus
import dev.jasonpearson.automobile.protocol.SavedPrototypeShortcutUpdate
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class SavedPrototypeControllerTest {
  private val spec =
    Json.decodeFromString<PrototypeSpec>(
      """{"id":"panel","window":{"placement":{"type":"fullscreen"}},"root":{"type":"text","text":"Hello"}}""",
    )
  private val imageSpec =
    Json.decodeFromString<PrototypeSpec>(
      """{"id":"panel","window":{"placement":{"type":"fullscreen"}},"root":{"type":"image","asset":"hero"}}""",
    )
  private val store = FakeSavedPrototypeStore { 42L }
  private val assets = MemoryAssets()
  private val shortcuts = FakeSavedPrototypeShortcuts()
  private val pinner = FakePrototypeShortcutPinner()
  private val replies = mutableListOf<PrototypeResult>()
  private val sink =
    object : PrototypeResultSink {
      override suspend fun send(requestId: String?, success: Boolean, error: String?) {
        replies += PrototypeResult(0, requestId, success, error)
      }

      override suspend fun sendPinned(requestId: String?, pin: SavedPrototypePinInfo) {
        replies += PrototypeResult(0, requestId, true, pin = pin)
      }

      override suspend fun sendSaved(requestId: String?, saved: SavedPrototypeInfo) {
        replies += PrototypeResult(0, requestId, true, saved = saved)
      }

      override suspend fun sendSavedList(requestId: String?, entries: List<SavedPrototypeEntry>) {
        replies += PrototypeResult(0, requestId, true, savedPrototypes = entries)
      }

      override suspend fun sendRefusal(
        requestId: String?,
        code: SavedPrototypeErrorCode,
        error: String,
      ) {
        replies += PrototypeResult(0, requestId, false, error = error, errorCode = code)
      }
    }

  private fun TestScope.controller(
    backing: SavedPrototypeStore = store,
    shortcutPinner: PrototypeShortcutPinner = pinner,
  ) =
    SavedPrototypeController(
      backing,
      assets,
      shortcuts,
      sink,
      StandardTestDispatcher(testScheduler),
      shortcutPinner,
    )

  private fun onlyReply(id: String): PrototypeResult {
    assertEquals(1, replies.size)
    return replies.single().also { assertEquals(id, it.requestId) }
  }

  @Test
  fun `save returns saved info and replacement flag once per request`() = runTest {
    val controller = controller()
    controller.save("first", spec, "Panel", null)
    assertEquals(SavedPrototypeInfo("panel", "fake-0", false), onlyReply("first").saved)
    assertEquals("Panel", store.stored.getValue("panel").label)
    replies.clear()
    controller.save("second", spec, "Updated", null)
    assertEquals(SavedPrototypeInfo("panel", "fake-0", true), onlyReply("second").saved)
    assertEquals("Updated", store.stored.getValue("panel").label)
  }

  @Test
  fun `icon is copied as an extra asset and repeated references are deduplicated`() = runTest {
    assets.bytes["hero"] = byteArrayOf(1)
    assets.bytes["icon"] = byteArrayOf(2)
    controller().save("extra", imageSpec, "Panel", "icon")
    assertTrue(onlyReply("extra").success)
    assertArrayEquals(byteArrayOf(1), store.stored.getValue("panel").assetBytes("hero"))
    assertArrayEquals(byteArrayOf(2), store.stored.getValue("panel").assetBytes("icon"))
    assertEquals(listOf("hero", "icon"), assets.reads)
    assets.reads.clear()
    replies.clear()
    controller().save("same", imageSpec, "Panel", "hero")
    assertTrue(onlyReply("same").success)
    assertEquals(listOf("hero"), assets.reads)
  }

  @Test
  fun `missing referenced assets refuse without storing`() = runTest {
    controller().save("missing", imageSpec, "Panel", "icon")
    val result = onlyReply("missing")
    assertEquals(SavedPrototypeErrorCode.MISSING_ASSET, result.errorCode)
    assertTrue(result.error.orEmpty().contains("hero"))
    assertTrue(result.error.orEmpty().contains("icon"))
    assertTrue(store.stored.isEmpty())
  }

  @Test
  fun `missing icon refuses even with a complete tree`() = runTest {
    controller().save("icon", spec, "Panel", "absent")
    assertEquals(SavedPrototypeErrorCode.MISSING_ASSET, onlyReply("icon").errorCode)
    assertTrue(store.stored.isEmpty())
  }

  @Test
  fun `evicted uploaded bytes refuse as missing asset`() = runTest {
    assets.bytes["hero"] = byteArrayOf(1)
    assets.evicted = true
    controller().save("evicted", imageSpec, "Panel", null)
    assertEquals(SavedPrototypeErrorCode.MISSING_ASSET, onlyReply("evicted").errorCode)
    assertTrue(store.stored.isEmpty())
  }

  @Test
  fun `invalid spec is rejected before assets or store are accessed`() = runTest {
    var saves = 0
    val backing =
      object : SavedPrototypeStore by store {
        override fun save(request: SavedPrototypeSaveRequest): SavedPrototypeSaveResult {
          saves++
          return store.save(request)
        }
      }
    controller(backing).save("invalid", spec.copy(motion = "invalid"), "Panel", null)
    assertEquals(SavedPrototypeErrorCode.INVALID_SPEC, onlyReply("invalid").errorCode)
    assertEquals(0, saves)
    assertTrue(assets.reads.isEmpty())
    assertTrue(store.stored.isEmpty())
  }

  @Test
  fun `every store rejection returns its typed code and message once`() = runTest {
    for (reason in enumValues<SavedPrototypeRejection>()) {
      val backing =
        object : SavedPrototypeStore by store {
          override fun save(request: SavedPrototypeSaveRequest) =
            SavedPrototypeSaveResult.Rejected(reason, "store refusal")
        }
      controller(backing).save("rejected", spec, "Panel", null)
      val result = onlyReply("rejected")
      assertEquals(SavedPrototypeErrorCode.valueOf(reason.name), result.errorCode)
      assertEquals("store refusal", result.error)
      assertFalse(result.success)
      replies.clear()
    }
  }

  @Test
  fun `list preserves store order and reads pinned ids once`() = runTest {
    val controller = controller()
    controller.save("b", spec.copy(id = "beta"), "Beta", null)
    controller.save("a", spec.copy(id = "alpha"), "Alpha", null)
    replies.clear()
    shortcuts.pinned = setOf(shortcutIdFor("beta"))
    controller.list("list")
    assertEquals(
      listOf(
        SavedPrototypeEntry("alpha", "Alpha", "fake-1", 42L, false),
        SavedPrototypeEntry("beta", "Beta", "fake-0", 42L, true),
      ),
      onlyReply("list").savedPrototypes,
    )
    assertEquals(1, shortcuts.reads)
  }

  @Test
  fun `list shortcut failure degrades to unpinned`() = runTest {
    val controller = controller()
    controller.save("save", spec, "Panel", null)
    replies.clear()
    shortcuts.failure = IllegalStateException("launcher unavailable")
    controller.list("list")
    assertFalse(checkNotNull(onlyReply("list").savedPrototypes).single().pinned)
    assertEquals(1, shortcuts.reads)
  }

  @Test
  fun `delete removes content and disables matching shortcut with message`() = runTest {
    val controller = controller()
    controller.save("save", spec, "Panel", null)
    replies.clear()
    controller.delete("delete", "panel")
    assertTrue(onlyReply("delete").success)
    assertTrue(store.stored.isEmpty())
    assertEquals(
      listOf(listOf(shortcutIdFor("panel")) to "This prototype was deleted"),
      shortcuts.disabled,
    )
  }

  @Test
  fun `unknown deletion refuses and never disables a shortcut`() = runTest {
    controller().delete("unknown", "absent")
    assertEquals(SavedPrototypeErrorCode.NOT_FOUND, onlyReply("unknown").errorCode)
    assertTrue(shortcuts.disabled.isEmpty())
  }

  @Test
  fun `delete shortcut failure still succeeds`() = runTest {
    val controller = controller()
    controller.save("save", spec, "Panel", null)
    replies.clear()
    shortcuts.failure = IllegalStateException("launcher unavailable")
    controller.delete("delete", "panel")
    assertTrue(onlyReply("delete").success)
    assertTrue(store.stored.isEmpty())
  }

  @Test
  fun `unexpected store exceptions return internal error once on every operation`() = runTest {
    val backing = failingStore(IllegalStateException("unexpected"))
    val controller = controller(backing)
    controller.save("save", spec, "Panel", null)
    assertEquals(SavedPrototypeErrorCode.INTERNAL_ERROR, onlyReply("save").errorCode)
    replies.clear()
    controller.list("list")
    assertEquals(SavedPrototypeErrorCode.INTERNAL_ERROR, onlyReply("list").errorCode)
    replies.clear()
    controller.delete("delete", "panel")
    assertEquals(SavedPrototypeErrorCode.INTERNAL_ERROR, onlyReply("delete").errorCode)
  }

  @Test
  fun `cancellation propagates without a sink call on every operation`() = runTest {
    val controller = controller(failingStore(CancellationException("cancelled")))
    for (action in
      listOf<suspend () -> Unit>(
        { controller.save("save", spec, "Panel", null) },
        { controller.list("list") },
        { controller.delete("delete", "panel") },
      )) {
      try {
        action()
        fail("Cancellation must propagate")
      } catch (error: CancellationException) {
        assertEquals("cancelled", error.message)
      }
      assertTrue(replies.isEmpty())
    }
  }

  @Test
  fun `pin maps requested and already pinned and reads only saved icon bytes`() = runTest {
    assets.bytes["icon"] = byteArrayOf(7)
    val controller = controller()
    controller.save("save", spec, "Saved label", "icon")
    assets.bytes.clear()
    for ((outcome, status) in
      listOf(
        PinOutcome.Requested to SavedPrototypePinStatus.REQUESTED,
        PinOutcome.AlreadyPinned(ShortcutUpdate.UPDATED) to SavedPrototypePinStatus.ALREADY_PINNED,
        PinOutcome.AlreadyPinned(ShortcutUpdate.RATE_LIMITED) to
          SavedPrototypePinStatus.ALREADY_PINNED,
      )) {
      replies.clear()
      pinner.outcome = outcome
      controller.pin("pin", "panel", "icon")
      val update =
        when (outcome) {
          is PinOutcome.AlreadyPinned ->
            if (outcome.update == ShortcutUpdate.UPDATED) SavedPrototypeShortcutUpdate.UPDATED
            else SavedPrototypeShortcutUpdate.RATE_LIMITED
          else -> null
        }
      assertEquals(SavedPrototypePinInfo("panel", status, update), onlyReply("pin").pin)
      assertEquals("Saved label", pinner.pins.last().shortLabel)
      assertArrayEquals(byteArrayOf(7), pinner.pins.last().iconBytes)
    }
    replies.clear()
    controller.pin("letter", "panel", null)
    assertEquals(null, pinner.pins.last().iconBytes)
    assertTrue(onlyReply("letter").success)
  }

  @Test
  fun `pin maps launcher failures without losing messages`() = runTest {
    val controller = controller()
    controller.save("save", spec, "Panel", null)
    for ((outcome, code) in
      listOf(
        PinOutcome.Unsupported("unsupported") to SavedPrototypeErrorCode.PIN_UNSUPPORTED,
        PinOutcome.DeviceLocked("unlock") to SavedPrototypeErrorCode.DEVICE_LOCKED,
        PinOutcome.Failed("failed") to SavedPrototypeErrorCode.PIN_FAILED,
      )) {
      replies.clear()
      pinner.outcome = outcome
      controller.pin("pin", "panel", null)
      assertEquals(code, onlyReply("pin").errorCode)
      assertFalse(replies.single().success)
      assertTrue(replies.single().error.orEmpty().isNotEmpty())
    }
  }

  @Test
  fun `pin refuses missing prototype or unsaved asset without calling pinner`() = runTest {
    val controller = controller()
    controller.pin("missing", "absent", null)
    assertEquals(SavedPrototypeErrorCode.NOT_FOUND, onlyReply("missing").errorCode)
    replies.clear()
    controller.save("save", spec, "Panel", null)
    replies.clear()
    assets.bytes["uploaded-only"] = byteArrayOf(1)
    controller.pin("asset", "panel", "uploaded-only")
    assertEquals(SavedPrototypeErrorCode.MISSING_ASSET, onlyReply("asset").errorCode)
    assertTrue(pinner.pins.isEmpty())
  }

  @Test
  fun `pin maps unsupported and corrupt storage`() = runTest {
    for ((loaded, code) in
      listOf(
        SavedPrototypeLoadResult.UnsupportedFormat(2) to SavedPrototypeErrorCode.UNSUPPORTED_FORMAT,
        SavedPrototypeLoadResult.Corrupt("corrupt") to SavedPrototypeErrorCode.STORAGE_FAILURE,
      )) {
      val backing =
        object : SavedPrototypeStore by store {
          override fun load(id: String) = loaded
        }
      replies.clear()
      controller(backing).pin("pin", "panel", null)
      assertEquals(code, onlyReply("pin").errorCode)
    }
  }

  @Test
  fun `replacement updates pinned shortcut with copied icon and typed status`() = runTest {
    assets.bytes["icon"] = byteArrayOf(9)
    val controller = controller()
    controller.save("first", spec, "Panel", "icon")
    assertEquals(1, pinner.updates.size)
    assertEquals(null, onlyReply("first").saved?.shortcut)
    for ((update, expected) in
      listOf(
        ShortcutUpdate.UPDATED to SavedPrototypeShortcutUpdate.UPDATED,
        ShortcutUpdate.RATE_LIMITED to SavedPrototypeShortcutUpdate.RATE_LIMITED,
        null to null,
      )) {
      replies.clear()
      pinner.updateResult = update
      controller.save("resave", spec, "New label", "icon")
      assertEquals(expected, onlyReply("resave").saved?.shortcut)
      assertEquals("New label", pinner.updates.last().shortLabel)
      assertArrayEquals(byteArrayOf(9), pinner.updates.last().iconBytes)
    }
    replies.clear()
    pinner.failure = IllegalStateException("launcher unavailable")
    controller.save("failed-update", spec, "Still saved", "icon")
    assertTrue(onlyReply("failed-update").success)
    assertEquals(null, replies.single().saved?.shortcut)
    pinner.failure = CancellationException("cancelled")
    replies.clear()
    try {
      controller.save("cancel", spec, "Panel", "icon")
      fail("Cancellation must propagate")
    } catch (error: CancellationException) {
      assertEquals("cancelled", error.message)
    }
    assertTrue(replies.isEmpty())
  }

  @Test
  fun `first save reports a pinned shortcut update even without replacing storage`() = runTest {
    pinner.updateResult = ShortcutUpdate.UPDATED
    controller().save("first", spec, "Panel", null)
    assertEquals(
      SavedPrototypeInfo("panel", "fake-0", false, SavedPrototypeShortcutUpdate.UPDATED),
      onlyReply("first").saved,
    )
    assertEquals(1, pinner.updates.size)
    assertEquals("Panel", pinner.updates.single().shortLabel)
  }

  @Test
  fun `delete then save re enables and updates the still pinned shortcut`() = runTest {
    val platform = FakePinnedShortcutPlatform().apply { pinned = setOf("panel") }
    shortcuts.onDisable = { ids -> platform.disabled.addAll(ids) }
    val controller = controller(shortcutPinner = PinnedPrototypeShortcuts(platform))
    controller.save("first", spec, "Panel", null)
    replies.clear()
    controller.delete("delete", "panel")
    assertTrue(onlyReply("delete").success)
    assertEquals(setOf("panel"), platform.disabled)
    platform.enabled.clear()
    platform.updates.clear()
    replies.clear()
    controller.save("resave", spec, "Restored", null)
    assertFalse(checkNotNull(onlyReply("resave").saved).replaced)
    assertEquals(SavedPrototypeShortcutUpdate.UPDATED, replies.single().saved?.shortcut)
    assertTrue(platform.disabled.isEmpty())
    assertEquals(listOf("panel"), platform.enabled.map { it.id })
    assertEquals("Restored", platform.updates.single().shortLabel)
    assertTrue(platform.requests.isEmpty())
  }

  private fun failingStore(error: Exception): SavedPrototypeStore =
    object : SavedPrototypeStore by store {
      override fun save(request: SavedPrototypeSaveRequest): SavedPrototypeSaveResult = throw error

      override fun list(): List<SavedPrototypeSummary> = throw error

      override fun delete(id: String): Boolean = throw error
    }

  private class MemoryAssets : PrototypeAssetSource {
    val bytes = linkedMapOf<String, ByteArray>()
    val reads = mutableListOf<String>()
    var evicted = false

    override fun lookup(id: String): PrototypeAssetInfo? =
      bytes[id]?.let { PrototypeAssetInfo(id, "image/png", it.size) }

    override fun read(id: String): ByteArray? {
      reads += id
      return if (evicted) null else bytes[id]?.copyOf()
    }

    override fun setChangeListener(listener: PrototypeAssetChangeListener?) = Unit
  }
}

internal class FakeSavedPrototypeShortcuts : SavedPrototypeShortcuts {
  var pinned = emptySet<String>()
  var reads = 0
  var failure: Exception? = null
  val disabled = mutableListOf<Pair<List<String>, String>>()
  var onDisable: (List<String>) -> Unit = {}

  override fun pinnedIds(): Set<String> {
    reads++
    failure?.let { throw it }
    return pinned
  }

  override fun disable(ids: List<String>, message: String) {
    failure?.let { throw it }
    disabled += ids to message
    onDisable(ids)
  }
}

internal class FakePrototypeShortcutPinner : PrototypeShortcutPinner {
  var outcome: PinOutcome = PinOutcome.Requested
  var updateResult: ShortcutUpdate? = null
  var failure: Exception? = null
  val pins = mutableListOf<PrototypeShortcut>()
  val updates = mutableListOf<PrototypeShortcut>()

  override fun pin(id: String, label: String, iconBytes: ByteArray?): PinOutcome {
    failure?.let { throw it }
    pins += PrototypeShortcut(id, label, label, iconBytes)
    return outcome
  }

  override fun updateIfPinned(id: String, label: String, iconBytes: ByteArray?): ShortcutUpdate? {
    failure?.let { throw it }
    updates += PrototypeShortcut(id, label, label, iconBytes)
    return updateResult
  }
}
