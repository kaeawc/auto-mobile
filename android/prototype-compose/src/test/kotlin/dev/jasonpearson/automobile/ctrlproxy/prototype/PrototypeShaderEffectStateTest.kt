package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeShader
import kotlinx.coroutines.CancellationException
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test

class PrototypeShaderEffectStateTest {
  private class Source : PrototypeAssetSource {
    var bytes: ByteArray? =
      "uniform float strength; half4 main(float2 p) { return half4(strength); }".toByteArray()

    override fun lookup(id: String) = bytes?.let {
      PrototypeAssetInfo(id, "application/vnd.automobile.agsl", it.size)
    }

    override fun read(id: String) = bytes

    override fun setChangeListener(listener: PrototypeAssetChangeListener?) = Unit
  }

  private class Fixture {
    val session = PrototypeShaderSession()
    val node = session.register("same")
    val source = Source()
    var compiles = 0
    var effects = 0
    var compileFailure: Exception? = null
    var failure: Exception? = null
    var values = emptyMap<String, Float>()
    val state =
      PrototypeShaderEffectState(
        session,
        node,
        PrototypeShaderCompiler {
          compiles++
          compileFailure?.let { Result.failure(it) }
            ?: Result.success(FakeCompiledPrototypeShader())
        },
        { compiled, uniforms ->
          effects++
          failure?.let { throw it }
          values = prototypeShaderUniformValues(compiled.floatUniforms, uniforms)
          "fake effect"
        },
      )

    fun prepare(version: Long = 0) = state.prepare(source, "effect", version)

    fun effect(value: Double? = null): String? =
      state.effect(
        checkNotNull(prepare()),
        PrototypeShader("effect", value?.let { mapOf("strength" to it) }),
      )
  }

  companion object {
    @JvmStatic
    @BeforeClass
    fun warm() {
      Fixture().effect(1.0)
    }
  }

  @Test
  fun `uniform changes reuse compilation and removed uniforms reset to zero`() {
    val f = Fixture()
    assertEquals("fake effect", f.effect(2.0))
    assertEquals(mapOf("strength" to 2f), f.values)
    assertEquals("fake effect", f.effect())
    assertEquals(mapOf("strength" to 0f), f.values)
    assertEquals(1, f.compiles)
    assertEquals(2, f.effects)
    f.source.bytes = "changed source".toByteArray()
    f.prepare(1)
    assertEquals(2, f.compiles)
    f.state.prepare(f.source, "otherAsset", 1)
    assertEquals(3, f.compiles)
    f.state.prepare(Source(), "otherAsset", 1)
    assertEquals(4, f.compiles)
  }

  @Test
  fun `missing asset retries on version change without disabling the instance`() {
    val f = Fixture()
    f.source.bytes = null
    assertNull(f.prepare())
    assertFalse(f.state.disabled)
    f.source.bytes = "source".toByteArray()
    assertNull(f.prepare())
    assertNotNull(f.prepare(1))
    assertEquals(1, f.compiles)
    assertTrue(f.session.failures().isEmpty())
  }

  @Test
  fun `real uniform validation failure disables only its composition instance`() {
    val f = Fixture()
    val other = f.session.register("same")
    assertNull(
      f.state.effect(checkNotNull(f.prepare()), PrototypeShader("effect", mapOf("unknown" to 1.0))),
    )
    assertTrue(f.state.disabled)
    assertNull(other.guard.disabledReason)
    assertTrue(f.session.failures().values.single().contains("not declared"))
    assertEquals(0, f.effects)
    assertNull(f.prepare(1))
    assertEquals(1, f.compiles)
  }

  @Test
  fun `effect and draw failures remain disabled across asset updates and fallback draws`() {
    val f = Fixture()
    val compiled = checkNotNull(f.prepare())
    f.failure = IllegalArgumentException("fake platform effect failed")
    assertNull(f.state.effect(compiled, PrototypeShader("effect")))
    val first = f.session.failures()
    var fallbackDrawn = false
    f.state.draw { fallbackDrawn = true }
    assertTrue(fallbackDrawn)
    f.state.draw { error("later draw failure") }
    assertEquals(first, f.session.failures())
    assertNull(f.prepare(1))
    assertNull(f.state.effect(compiled, PrototypeShader("effect")))
    assertEquals(1, f.effects)
  }

  @Test
  fun `compile and draw failures flow through the same permanent guard`() {
    val f = Fixture()
    f.source.bytes = byteArrayOf(0xc3.toByte())
    assertNull(f.prepare())
    assertTrue(f.state.disabled)
    assertTrue(f.session.failures().values.single().contains("valid UTF-8"))
    val draw = Fixture()
    draw.state.draw { error("fake draw failure") }
    assertTrue(draw.state.disabled)
    assertTrue(draw.session.failures().values.single().contains("Shader draw failed"))
  }

  @Test
  fun `injected compiler rejection disables preparation without creating an effect`() {
    val f = Fixture()
    f.compileFailure = IllegalArgumentException("error: 2: fake compiler rejection")
    assertNull(f.prepare())
    assertTrue(f.state.disabled)
    assertEquals(0, f.effects)
    assertTrue(f.session.failures().values.single().contains("fake compiler rejection"))
    assertNull(f.prepare(1))
    assertEquals(1, f.compiles)
  }

  @Test
  fun `session frame failure disables all effects and is reported once`() {
    val f = Fixture()
    val other = f.session.register("same")
    val otherState =
      PrototypeShaderEffectState(
        f.session,
        other,
        PrototypeShaderCompiler { error("must not compile after session failure") },
        { _: PrototypeCompiledShader, _: Map<String, Double> -> error("must not apply") },
      )
    val compiled = checkNotNull(f.prepare())
    f.session.setActive(f.node, true)
    f.session.setActive(other, true)
    f.session.setVisible(true)
    f.session.frame(0)
    repeat(8) { f.session.frame((it + 1) * 25_000_000L) }
    assertTrue(f.state.disabled)
    assertTrue(otherState.disabled)
    assertNull(f.state.effect(compiled, PrototypeShader("effect")))
    assertNull(otherState.prepare(f.source, "effect", 1))
    assertEquals(0, f.effects)
    assertEquals(1, f.session.failures().size)
  }

  @Test
  fun `cancellation propagates without recording a shader failure`() {
    val f = Fixture()
    f.failure = CancellationException("effect cancelled")
    assertTrue(runCatching { f.effect() }.exceptionOrNull() is CancellationException)
    assertFalse(f.state.disabled)
    assertTrue(f.session.failures().isEmpty())
  }

  @Test
  fun `cancelled preparation never caches an old shader under a new asset key`() {
    val session = PrototypeShaderSession()
    val source = Source()
    var cancel = false
    var calls = 0
    val state =
      PrototypeShaderEffectState(
        session,
        session.register("same"),
        PrototypeShaderCompiler {
          calls++
          if (cancel) throw CancellationException("cancel compile")
          Result.success(FakeCompiledPrototypeShader())
        },
        { _: PrototypeCompiledShader, _: Map<String, Double> -> "fake effect" },
      )
    val first = state.prepare(source, "first", 0)
    cancel = true
    assertTrue(
      runCatching { state.prepare(source, "second", 0) }.exceptionOrNull() is CancellationException,
    )
    cancel = false
    assertNotSame(first, state.prepare(source, "second", 0))
    assertEquals(3, calls)
    assertTrue(session.failures().isEmpty())
  }
}
