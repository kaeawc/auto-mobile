package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.os.Build
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.unit.dp
import dev.chrisbanes.haze.HazeState
import dev.jasonpearson.automobile.protocol.PrototypeBoxNode
import dev.jasonpearson.automobile.protocol.PrototypeCardNode
import dev.jasonpearson.automobile.protocol.PrototypeColumnNode
import dev.jasonpearson.automobile.protocol.PrototypeCornerRadius
import dev.jasonpearson.automobile.protocol.PrototypeFullscreenPlacement
import dev.jasonpearson.automobile.protocol.PrototypeGlass
import dev.jasonpearson.automobile.protocol.PrototypeListNode
import dev.jasonpearson.automobile.protocol.PrototypeModeValue
import dev.jasonpearson.automobile.protocol.PrototypeRepeat
import dev.jasonpearson.automobile.protocol.PrototypeSpacerNode
import dev.jasonpearson.automobile.protocol.PrototypeSpec
import dev.jasonpearson.automobile.protocol.PrototypeStyle
import dev.jasonpearson.automobile.protocol.PrototypeWindow
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
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
  fun `glass without a cornerRadius is a capsule and other surfaces stay rectangles`() {
    val shapes = androidx.compose.material3.Shapes()
    assertEquals(
      RoundedCornerShape(percent = 50),
      prototypeSurfaceShape(shapes, PrototypeStyle(surface = "glass")),
    )
    assertEquals(RectangleShape, prototypeSurfaceShape(shapes, PrototypeStyle()))
    assertEquals(
      RoundedCornerShape(8.dp),
      prototypeSurfaceShape(
        shapes,
        PrototypeStyle(surface = "glass", cornerRadius = PrototypeCornerRadius.Dp(8.0)),
      ),
    )
  }

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

  @Test
  @Config(sdk = [33])
  fun `glass only inside lazy list rows still registers layers for each row`() {
    val root =
      mapPrototypeSpec(
          PrototypeSpec(
            "glass-rows",
            PrototypeWindow(PrototypeFullscreenPlacement()),
            data =
              buildJsonObject {
                putJsonArray("items") {
                  listOf("a", "b").forEach { id -> addJsonObject { put("id", id) } }
                }
              },
            root =
              PrototypeColumnNode(
                children =
                  listOf(
                    PrototypeListNode(
                      repeat = PrototypeRepeat(emptyList(), "it", "/items", "id"),
                      children =
                        listOf(
                          PrototypeBoxNode(
                            children =
                              listOf(
                                PrototypeSpacerNode(),
                                PrototypeSpacerNode(style = PrototypeStyle(surface = "glass")),
                              ),
                          ),
                        ),
                    ),
                  ),
              ),
          ),
        )
        .root
    val list = root.children.single()
    assertTrue(list.children.isEmpty())
    val model = checkNotNull(list.list)
    val (first, second) = model.rows.mapIndexed { index, item -> model.render(item, index) }
    val layers = checkNotNull(prototypeGlassLayers(root, HazeState()))
    val (firstBackdrop, firstGlass) = first.children
    val (secondBackdrop, secondGlass) = second.children
    assertEquals(setOf(firstBackdrop.identity), layers.behind[firstGlass.identity])
    // A later row samples earlier rows like any later sibling, never itself or later rows.
    assertEquals(
      setOf(first.identity, secondBackdrop.identity),
      layers.behind[secondGlass.identity],
    )
    assertEquals(2, layers.behind.size)
    assertTrue(firstBackdrop.identity in layers.sourceOrder)
    assertTrue(first.identity in layers.sourceOrder)
  }

  @Test
  fun `lazy list rows without glass are not mapped for glass layers`() {
    val root =
      mapPrototypeSpec(
          PrototypeSpec(
            "plain-rows",
            PrototypeWindow(PrototypeFullscreenPlacement()),
            data = buildJsonObject { putJsonArray("items") { addJsonObject { put("id", "a") } } },
            root =
              PrototypeListNode(
                repeat = PrototypeRepeat(emptyList(), "it", "/items", "id"),
                children = listOf(PrototypeSpacerNode()),
              ),
          ),
        )
        .root
    assertNull(prototypeGlassLayers(root, HazeState()))
  }

  @Test
  fun `a root card without a cornerRadius backs onto Material's default card shape`() {
    fun shape(root: dev.jasonpearson.automobile.protocol.PrototypeNode) =
      prototypeRootBackdropShape(
        mapPrototypeSpec(
          PrototypeSpec("card", PrototypeWindow(PrototypeFullscreenPlacement()), root = root),
        ),
      )
    val shapes = androidx.compose.material3.Shapes()
    assertEquals(shapes.medium, shape(PrototypeCardNode(children = listOf(PrototypeSpacerNode()))))
    assertEquals(
      RoundedCornerShape(18.dp),
      shape(
        PrototypeCardNode(
          style = PrototypeStyle(cornerRadius = PrototypeCornerRadius.Dp(18.0)),
          children = listOf(PrototypeSpacerNode()),
        ),
      ),
    )
    assertEquals(
      RoundedCornerShape(percent = 50),
      shape(
        PrototypeCardNode(
          style = PrototypeStyle(surface = "glass"),
          children = listOf(PrototypeSpacerNode()),
        ),
      ),
    )
    assertEquals(RectangleShape, shape(PrototypeBoxNode(children = listOf(PrototypeSpacerNode()))))
  }
}
