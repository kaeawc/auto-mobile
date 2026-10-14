package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.content.Context
import android.content.Intent
import android.content.pm.ShortcutManager
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.drawable.Icon
import androidx.test.core.app.ApplicationProvider
import java.io.ByteArrayOutputStream
import kotlinx.coroutines.CancellationException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.util.ReflectionHelpers

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class AndroidPinnedShortcutPlatformTest {
  private val context = ApplicationProvider.getApplicationContext<Context>()
  private val manager by lazy { context.getSystemService(ShortcutManager::class.java) }
  private val shadow by lazy { shadowOf(manager) }
  private val platform = AndroidPinnedShortcutPlatform(context)

  @Test
  fun `support tracks launcher and request carries only the viewer URI`() {
    shadow.setIsRequestPinShortcutSupported(false)
    assertFalse(platform.isRequestPinSupported())
    shadow.setIsRequestPinShortcutSupported(true)
    assertTrue(platform.isRequestPinSupported())
    assertTrue(platform.requestPin(PrototypeShortcut("panel/one", "Panel", "Panel one", null)))
    val shortcut = manager.pinnedShortcuts.single()
    assertEquals("panel/one", shortcut.id)
    assertEquals("Panel", shortcut.shortLabel.toString())
    assertEquals("Panel one", shortcut.longLabel.toString())
    val intent = checkNotNull(shortcut.intent)
    assertEquals(context.packageName, intent.component?.packageName)
    assertEquals(
      "dev.jasonpearson.automobile.ctrlproxy.prototype.SavedPrototypeActivity",
      intent.component?.className,
    )
    assertEquals(Intent.ACTION_VIEW, intent.action)
    assertEquals("automobile-saved-prototype", intent.data?.scheme)
    assertEquals(listOf("panel/one"), intent.data?.pathSegments)
    assertEquals(Intent.FLAG_ACTIVITY_NEW_DOCUMENT, intent.flags)
    assertNull(intent.extras)
    assertEquals(setOf("panel/one"), platform.pinnedIds())
    assertTrue(platform.update(PrototypeShortcut("panel/one", "Updated", "Updated panel", null)))
    assertEquals("Updated", manager.pinnedShortcuts.single().shortLabel.toString())
  }

  @Test
  @Config(sdk = [24])
  fun `pre Oreo performs no shortcut operations`() {
    assertFalse(platform.isRequestPinSupported())
    assertTrue(platform.pinnedIds().isEmpty())
    assertFalse(platform.requestPin(PrototypeShortcut("panel", "Panel", "Panel", null)))
    assertFalse(platform.update(PrototypeShortcut("panel", "Panel", "Panel", null)))
    val guarded =
      AndroidPinnedShortcutPlatform(
        context,
        ShortcutIntentFactory { error("Pre-Oreo must not build intents") },
        ShortcutIconRenderer { _, _ -> error("Pre-Oreo must not render icons") },
      )
    assertFalse(guarded.requestPin(PrototypeShortcut("panel", "Panel", "Panel", null)))
    assertFalse(guarded.update(PrototypeShortcut("panel", "Panel", "Panel", null)))
    guarded.enable(PrototypeShortcut("panel", "Panel", "Panel", null))
  }

  @Test
  fun `new pin renders fallback but null icon updates omit icon without rendering`() {
    var renders = 0
    val guarded =
      AndroidPinnedShortcutPlatform(
        context,
        icons =
          ShortcutIconRenderer { _, _ ->
            renders++
            Bitmap.createBitmap(8, 8, Bitmap.Config.ARGB_8888)
          },
      )
    val shortcut = PrototypeShortcut("panel", "Panel", "Panel", null)
    assertTrue(guarded.requestPin(shortcut))
    assertNotNull(ReflectionHelpers.getField<Icon?>(manager.pinnedShortcuts.single(), "mIcon"))
    assertEquals(1, renders)
    assertTrue(guarded.update(shortcut))
    // The shadow stores the submitted update, without Android's field-merging semantics.
    assertNull(ReflectionHelpers.getField<Icon?>(manager.pinnedShortcuts.single(), "mIcon"))
    assertEquals(1, renders)
    assertTrue(guarded.update(PrototypeShortcut("panel", "Panel", "Panel", byteArrayOf(1))))
    assertNotNull(ReflectionHelpers.getField<Icon?>(manager.pinnedShortcuts.single(), "mIcon"))
    assertEquals(2, renders)
  }

  @Test
  fun `enable builds label and intent without rendering and restores a disabled pinned shortcut`() {
    val shortcut = PrototypeShortcut("panel", "Panel", "Panel", null)
    assertTrue(platform.requestPin(shortcut))
    manager.disableShortcuts(listOf("panel"))
    assertEquals(setOf("panel"), platform.pinnedIds())
    assertThrows(IllegalArgumentException::class.java) { platform.requestPin(shortcut) }
    val intentIds = mutableListOf<String>()
    val guarded =
      AndroidPinnedShortcutPlatform(
        context,
        ShortcutIntentFactory { id ->
          intentIds += id
          SavedPrototypeShortcutIntents(context).intentFor(id)
        },
        ShortcutIconRenderer { _, _ -> error("Enable must not render icons") },
      )
    guarded.enable(PrototypeShortcut("panel", "Updated", "Updated panel", byteArrayOf(1)))
    assertEquals(listOf("panel"), intentIds)
    assertTrue(platform.requestPin(shortcut))
  }

  @Test
  fun `intent and renderer illegal state failures are wrapped before requesting pin`() {
    val failure = IllegalStateException("cannot build")
    val brokenIntents =
      AndroidPinnedShortcutPlatform(context, ShortcutIntentFactory { throw failure })
    val brokenIcons =
      AndroidPinnedShortcutPlatform(context, icons = ShortcutIconRenderer { _, _ -> throw failure })
    val shortcut = PrototypeShortcut("panel", "Panel", "Panel", null)
    for (broken in listOf(brokenIntents, brokenIcons)) {
      val error = assertThrows(IllegalArgumentException::class.java) { broken.requestPin(shortcut) }
      assertEquals(failure, error.cause)
      assertTrue(PinnedPrototypeShortcuts(broken).pin("panel", "Panel", null) is PinOutcome.Failed)
    }
    assertTrue(manager.pinnedShortcuts.isEmpty())
  }

  @Test
  fun `shortcut building cancellation is never wrapped`() {
    val broken =
      AndroidPinnedShortcutPlatform(
        context,
        icons = ShortcutIconRenderer { _, _ -> throw CancellationException("cancelled") },
      )
    assertThrows(CancellationException::class.java) {
      PinnedPrototypeShortcuts(broken).pin("panel", "Panel", null)
    }
  }

  @Test
  @GraphicsMode(GraphicsMode.Mode.NATIVE)
  fun `transparent PNG corner uses a white background`() {
    val source = Bitmap.createBitmap(4, 4, Bitmap.Config.ARGB_8888)
    source.eraseColor(Color.TRANSPARENT)
    source.setPixel(3, 3, Color.BLUE)
    val bytes =
      ByteArrayOutputStream()
        .also { source.compress(Bitmap.CompressFormat.PNG, 100, it) }
        .toByteArray()
    source.recycle()
    val bitmap = AndroidShortcutIconRenderer(context).render(bytes, "Panel")
    try {
      assertEquals(Color.WHITE, bitmap.getPixel(0, 0))
      assertEquals(Color.WHITE, bitmap.getPixel(bitmap.width / 3, bitmap.height / 3))
      assertEquals(255, Color.alpha(bitmap.getPixel(bitmap.width / 2, bitmap.height / 2)))
    } finally {
      bitmap.recycle()
    }
  }

  @Test
  @GraphicsMode(GraphicsMode.Mode.NATIVE)
  fun `letter fallback is square capped opaque and deterministic`() {
    shadow.setIconMaxWidth(64)
    shadow.setIconMaxHeight(48)
    val renderer = AndroidShortcutIconRenderer(context)
    val bitmap = renderer.render(null, "Panel")
    val bad = renderer.render(byteArrayOf(1, 2), "Panel")
    val blank = renderer.render(null, "")
    try {
      assertEquals(48, bitmap.width)
      assertEquals(bitmap.width, bitmap.height)
      assertEquals(255, Color.alpha(bitmap.getPixel(0, 0)))
      assertTrue(bitmap.sameAs(bad))
      assertEquals(255, Color.alpha(blank.getPixel(0, 0)))
      var white = false
      for (y in 0 until bitmap.height) for (x in 0 until bitmap.width) {
        if (bitmap.getPixel(x, y) == Color.WHITE) white = true
      }
      assertTrue(white)
    } finally {
      bitmap.recycle()
      bad.recycle()
      blank.recycle()
    }
  }

  @Test
  @GraphicsMode(GraphicsMode.Mode.NATIVE)
  fun `real PNG draws inside safe zone over its background colour`() {
    shadow.setIconMaxWidth(108)
    shadow.setIconMaxHeight(108)
    val source = Bitmap.createBitmap(4, 2, Bitmap.Config.ARGB_8888)
    source.eraseColor(Color.RED)
    source.setPixel(2, 1, Color.BLUE)
    val bytes =
      ByteArrayOutputStream()
        .also { source.compress(Bitmap.CompressFormat.PNG, 100, it) }
        .toByteArray()
    source.recycle()
    val bitmap = AndroidShortcutIconRenderer(context).render(bytes, "Panel")
    try {
      assertEquals(Color.RED, bitmap.getPixel(0, 0))
      assertEquals(255, Color.alpha(bitmap.getPixel(bitmap.width / 2, bitmap.height / 2)))
      assertNotEquals(Color.RED, bitmap.getPixel(bitmap.width / 2, bitmap.height * 2 / 3))
    } finally {
      bitmap.recycle()
    }
  }
}
