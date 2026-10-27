package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.ui.graphics.BlurEffect
import androidx.compose.ui.graphics.GraphicsLayerScope
import androidx.compose.ui.graphics.RenderEffect
import dev.jasonpearson.automobile.protocol.PrototypeShader
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test

class PrototypeShaderLayerTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun warm() {
      GraphicsLayerScope()
      BlurEffect(1f, 1f)
    }
  }

  @Test
  fun `layer clips output and clears its effect after a real validation failure`() {
    // Compose effect descriptors and a recording scope are pure JVM objects, with no native draw.
    val effect = BlurEffect(1f, 1f)
    val scope = GraphicsLayerScope()
    val session = PrototypeShaderSession()
    val state =
      PrototypeShaderEffectState<RenderEffect>(
        session,
        session.register("node"),
        PrototypeShaderCompiler { error("unused") },
        { _, _ -> effect },
      )
    val compiled = FakeCompiledPrototypeShader()
    assertSame(effect, state.effect(compiled, PrototypeShader("effect")))
    scope.prototypeShaderLayer(effect, state.disabled)
    assertTrue(scope.clip)
    assertSame(effect, scope.renderEffect)
    assertNull(state.effect(compiled, PrototypeShader("effect", mapOf("missing" to 1.0))))
    scope.prototypeShaderLayer(effect, state.disabled)
    assertTrue(scope.clip)
    assertNull(scope.renderEffect)
    assertEquals(1, session.failures().size)
  }
}
