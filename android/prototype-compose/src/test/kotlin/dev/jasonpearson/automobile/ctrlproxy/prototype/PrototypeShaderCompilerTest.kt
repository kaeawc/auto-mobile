package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.ui.graphics.RenderEffect
import java.io.File
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test

internal class FakeCompiledPrototypeShader(
  override val floatUniforms: Set<String> = setOf("strength"),
) : PrototypeCompiledShader {
  var effectCalls = 0

  override fun effect(uniforms: Map<String, Double>): RenderEffect {
    effectCalls++
    error("Fake effect: no GPU")
  }
}

class PrototypeShaderCompilerTest {
  companion object {
    private lateinit var cases: JsonArray
    private lateinit var compiledFixture: FakeCompiledPrototypeShader

    @JvmStatic
    @BeforeClass
    fun fixtures() {
      val fixture =
        generateSequence(File(System.getProperty("user.dir") ?: ".").absoluteFile) { it.parentFile }
          .map { File(it, "test/fixtures/prototype-spec/shader-assets.json") }
          .first { it.isFile }
      cases = Json.parseToJsonElement(fixture.readText()).jsonObject.getValue("cases").jsonArray
      compiledFixture = FakeCompiledPrototypeShader()
      val compiler = AndroidPrototypeShaderCompiler({ 33 }) { _, _ -> compiledFixture }
      check(
        compiler
          .compile("uniform float strength; half4 main(float2 p) { return half4(strength); }")
          .isSuccess,
      )
    }
  }

  @Test
  fun `device lexical preflight matches the shared host fixture`() {
    cases.forEach { entry ->
      val obj = entry.jsonObject
      val source = obj.getValue("source").jsonPrimitive.content
      val result = runCatching { prototypeShaderDeclarations(source) }
      assertEquals(
        obj.getValue("name").jsonPrimitive.content,
        obj.getValue("valid").jsonPrimitive.boolean,
        result.isSuccess,
      )
    }
  }

  @Test
  fun `API 33 compiles declared float names and preserves content source`() {
    val source =
      "uniform shader content; uniform float strength; half4 main(float2 p) { return content.eval(p) * strength; }"
    var received = ""
    val fake = FakeCompiledPrototypeShader()
    val compiler =
      AndroidPrototypeShaderCompiler({ 33 }) { program, floats ->
        received = program
        assertEquals(setOf("strength"), floats)
        fake
      }
    assertSame(fake, compiler.compile(source).getOrThrow())
    assertEquals(source, received)
  }

  @Test
  fun `procedural shaders get only the required unused content input`() {
    var received = ""
    val compiler =
      AndroidPrototypeShaderCompiler({ 33 }) { program, _ ->
        received = program
        FakeCompiledPrototypeShader()
      }
    val source = "half4 main(float2 p) { return half4(1); }"
    assertTrue(compiler.compile(source).isSuccess)
    assertEquals("uniform shader content;\n$source", received)
  }

  @Test
  fun `platform compiler failures and lexical refusals remain failures`() {
    var calls = 0
    val compiler =
      AndroidPrototypeShaderCompiler({ 33 }) { _, _ ->
        calls++
        throw IllegalArgumentException("line 1: invalid AGSL")
      }
    assertEquals("line 1: invalid AGSL", compiler.compile("bad").exceptionOrNull()?.message)
    assertTrue(compiler.compile("uniform shader externalInput;").isFailure)
    assertEquals(1, calls)
  }

  @Test
  fun `compiler diagnostics subtract only the injected source line`() {
    val message = "error: 3: unknown name\nline 5: invalid expression\n2 errors"
    val compiler =
      AndroidPrototypeShaderCompiler({ 33 }) { _, _ ->
        throw IllegalArgumentException(message)
      }
    assertEquals(
      "error: 2: unknown name\nline 4: invalid expression\n2 errors",
      compiler.compile("bad").exceptionOrNull()?.message,
    )
    assertEquals(
      message,
      compiler.compile("uniform shader content;\nbad").exceptionOrNull()?.message,
    )
  }

  @Test
  fun `only declared finite float values are set and bounds are clamped`() {
    assertEquals(
      mapOf("strength" to 1_000_000f),
      prototypeShaderUniformValues(setOf("strength"), mapOf("strength" to 2_000_000.0)),
    )
    assertEquals(
      mapOf("strength" to -1_000_000f),
      prototypeShaderUniformValues(setOf("strength"), mapOf("strength" to -2_000_000.0)),
    )
    assertTrue(
      runCatching { prototypeShaderUniformValues(setOf("strength"), mapOf("other" to 1.0)) }
        .isFailure,
    )
    assertTrue(
      runCatching {
        prototypeShaderUniformValues(setOf("strength"), mapOf("strength" to Double.NaN))
      }
        .isFailure,
    )
    assertEquals(
      mapOf("strength" to 0f),
      prototypeShaderUniformValues(setOf("strength"), emptyMap()),
    )
  }

  @Test
  fun `undeclared uniforms fail before any effect or uniform write`() {
    val compiled = compiledFixture
    val source =
      object : PrototypeAssetSource {
        override fun lookup(id: String) =
          PrototypeAssetInfo(id, "application/vnd.automobile.agsl", 1)

        override fun read(id: String) = byteArrayOf(32)

        override fun setChangeListener(listener: PrototypeAssetChangeListener?) = Unit
      }
    val session = PrototypeShaderSession()
    val state =
      PrototypeShaderEffectState(
        session,
        session.register("node"),
        PrototypeShaderCompiler { Result.success(compiled) },
        { shader, uniforms -> shader.effect(uniforms) },
      )
    val program = checkNotNull(state.prepare(source, "effect", 0))
    assertNull(
      state.effect(
        program,
        dev.jasonpearson.automobile.protocol.PrototypeShader("effect", mapOf("undeclared" to 1.0)),
      ),
    )
    assertTrue(session.failures().values.single().contains("not declared"))
    assertEquals(0, compiled.effectCalls)
  }

  @Test
  fun `capability is available starting at API 33`() {
    assertTrue(prototypeShaderCapabilities(32).isEmpty())
    assertEquals(setOf("prototype_custom_shaders_v1"), prototypeShaderCapabilities(33))
  }
}
