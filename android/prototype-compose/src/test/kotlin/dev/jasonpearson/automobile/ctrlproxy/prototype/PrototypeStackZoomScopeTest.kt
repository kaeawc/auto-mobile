@file:OptIn(androidx.compose.animation.ExperimentalSharedTransitionApi::class)

package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.SharedTransitionScope
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.protocol.*
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class PrototypeStackZoomScopeTest {
  @get:Rule val compose = createComposeRule()

  @Test
  fun `nonzoom patterns never install zoom modifiers for shared keys`() {
    val root = stackZoomRuntime("standard").renderModel().root.children.first()
    compose.setContent {
      FullMotion {
        Column {
          PrototypeStackTransition.entries
            .filter { it != PrototypeStackTransition.ZOOM }
            .forEach { pattern ->
              val animation = resolveStackTransition(pattern, null, true, false)
              AnimatedVisibility(true) {
                PrototypeStackZoomScreen(
                  PrototypeStackChange("nav", "push", pattern, source = "hero").takeIf {
                    animation == StackTransitionKind.Zoom
                  },
                  0 to "home",
                  root,
                  this,
                ) {
                  assertNull(LocalPrototypeStackZoom.current)
                  assertSame(Modifier, Modifier.prototypeStackZoomNode(root.children.first()))
                }
              }
            }
        }
      }
    }
    compose.waitForIdle()
  }

  @Test
  fun `zoom only captures its selected source key`() {
    val root = stackZoomRuntime("standard").renderModel().root.children.first()
    compose.setContent {
      FullMotion {
        PrototypeStackSharedRoot(true, Modifier) {
          AnimatedVisibility(true) {
            PrototypeStackZoomScreen(
              PrototypeStackChange("nav", "push", source = "another", zoomTarget = 1 to "detail"),
              0 to "home",
              root,
              this,
            ) {
              assertNotNull(LocalPrototypeStackZoom.current)
              assertSame(Modifier, Modifier.prototypeStackZoomNode(root.children.first()))
            }
          }
        }
      }
    }
  }

  @Test
  fun `zoom override measures a source on a stack whose default is slide`() {
    val runtime = stackZoomRuntime("standard", "slide")
    compose.setContent {
      Box(Modifier.size(300.dp)) { PrototypeRuntimeContent(runtime) { runtime.handle(it) } }
    }
    compose.waitForIdle()
    compose.mainClock.autoAdvance = false
    val start = stackZoomInkBounds(compose.onRoot())
    compose.runOnUiThread {
      runBlocking {
        runtime.handle(
          PrototypeInteraction.Tap(
            listOf(
              PrototypePushAction("nav", "detail", transition = "zoom", source = "hero"),
            ),
          ),
        )
      }
    }
    repeat(4) { compose.mainClock.advanceTimeByFrame() }
    compose.mainClock.advanceTimeBy(100)
    val mid = stackZoomInkBounds(compose.onRoot())
    compose.mainClock.advanceTimeBy(1000)
    val end = stackZoomInkBounds(compose.onRoot())
    assertTrue("$start -> $mid -> $end", mid.width > start.width && mid.width < end.width)
    assertTrue(mid.height > start.height && mid.height < end.height)
  }

  @Test
  fun `nonzoom shared root preserves parent data without allocating a scope`() {
    compose.setContent {
      Row(Modifier.size(300.dp)) {
        PrototypeStackSharedRoot(false, Modifier.weight(1f)) { modifier ->
          assertNull(LocalPrototypeSharedTransition.current)
          Box(modifier.fillMaxSize().testTag("stack"))
        }
        Box(Modifier.width(100.dp))
      }
    }
    compose.onNodeWithTag("stack").assertWidthIsEqualTo(200.dp)
  }

  @Test
  fun `standalone zoom keeps weight on its outer layout node`() {
    compose.setContent {
      Row(Modifier.size(300.dp)) {
        PrototypeStackSharedRoot(true, Modifier.weight(1f)) { modifier ->
          assertNotNull(LocalPrototypeSharedTransition.current)
          Box(modifier.fillMaxSize().testTag("stack"))
        }
        Box(Modifier.width(100.dp))
      }
    }
    compose.onNodeWithTag("stack").assertWidthIsEqualTo(200.dp)
  }

  @Test
  fun `zoom reuses an outer shared scope and preserves the incoming modifier`() {
    compose.setContent {
      SharedTransitionScope { sharedModifier ->
        val outer = this
        Box(sharedModifier) {
          CompositionLocalProvider(LocalPrototypeSharedTransition provides outer) {
            val incoming = Modifier.size(200.dp)
            PrototypeStackSharedRoot(true, incoming) { modifier ->
              assertSame(outer, LocalPrototypeSharedTransition.current)
              assertSame(incoming, modifier)
              Box(modifier)
            }
          }
        }
      }
    }
  }

  @Composable
  private fun FullMotion(content: @Composable () -> Unit) {
    CompositionLocalProvider(
      LocalPrototypeMotion provides true,
      LocalPrototypeMotionProfile provides PrototypeMotionProfile.FULL,
      content = content,
    )
  }
}
