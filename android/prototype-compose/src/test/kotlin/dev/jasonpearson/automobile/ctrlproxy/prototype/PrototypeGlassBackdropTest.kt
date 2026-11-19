package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.os.Build
import dev.chrisbanes.haze.HazeState
import dev.jasonpearson.automobile.protocol.PrototypeBoxNode
import dev.jasonpearson.automobile.protocol.PrototypeFullscreenPlacement
import dev.jasonpearson.automobile.protocol.PrototypeGlass
import dev.jasonpearson.automobile.protocol.PrototypeModeValue
import dev.jasonpearson.automobile.protocol.PrototypeSpacerNode
import dev.jasonpearson.automobile.protocol.PrototypeSpec
import dev.jasonpearson.automobile.protocol.PrototypeStyle
import dev.jasonpearson.automobile.protocol.PrototypeWindow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
class PrototypeGlassBackdropTest {
  @Test
  @Config(sdk = [30])
  fun `Android 11 glass uses the themed tonal scrim`() {
    val glass = checkNotNull(PrototypeStyle(surface = "glass").glassMaterial())
    val plan = prototypeGlassPlan(glass, Build.VERSION.SDK_INT)
    assertFalse(plan.blur)
    assertEquals(24, plan.radiusDp)
    assertNull(plan.tint)
    assertEquals(
      PrototypeModeValue.Single(PrototypeBackdrops.DEFAULT_TONAL_ROLE),
      plan.fallbackTint,
    )
  }

  @Test
  @Config(sdk = [33])
  fun `Android 13 glass enables Haze blur and retains its mode-aware tint for fallback`() {
    val tint = PrototypeModeValue.Single("surface")
    val style =
      PrototypeStyle(surface = "glass", glass = PrototypeGlass(variant = "clear", tint = tint))
    val plan = prototypeGlassPlan(checkNotNull(style.glassMaterial()), Build.VERSION.SDK_INT)
    assertTrue(plan.blur)
    assertEquals(8, plan.radiusDp)
    assertEquals(tint, plan.tint)
    assertEquals(tint, plan.fallbackTint)
    assertEquals(
      24,
      prototypeGlassPlan(PrototypeGlass(variant = "regular"), Build.VERSION.SDK_INT).radiusDp,
    )
  }

  @Test
  @Config(sdk = [33])
  fun `glass samples earlier sibling subtrees at each level`() {
    val root =
      mapPrototypeSpec(
          PrototypeSpec(
            "glass",
            PrototypeWindow(PrototypeFullscreenPlacement()),
            root =
              PrototypeBoxNode(
                children =
                  listOf(
                    PrototypeBoxNode(children = listOf(PrototypeSpacerNode())),
                    PrototypeBoxNode(
                      children =
                        listOf(
                          PrototypeSpacerNode(),
                          PrototypeSpacerNode(style = PrototypeStyle(surface = "glass")),
                          PrototypeSpacerNode(),
                        ),
                    ),
                  ),
              ),
          ),
        )
        .root
    val (outerBackdrop, parent) = root.children
    val (innerBackdrop, glass, _) = parent.children
    val layers = checkNotNull(prototypeGlassLayers(root, HazeState()))
    assertEquals(
      setOf(outerBackdrop.identity, innerBackdrop.identity),
      layers.behind[glass.identity],
    )
    assertEquals(
      listOf(outerBackdrop.identity, innerBackdrop.identity),
      layers.sourceOrder.entries.sortedBy { it.value }.map { it.key },
    )
  }
}
