package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.graphics.RuntimeShader
import androidx.annotation.RequiresApi
import androidx.compose.ui.graphics.RenderEffect
import androidx.compose.ui.graphics.asComposeRenderEffect

@RequiresApi(33)
internal fun compileAndroidPrototypeShader(
  source: String,
  floats: Set<String>,
): PrototypeCompiledShader {
  val shader = RuntimeShader(source)
  // The platform verifies that the lexical declarations really are compiled scalar floats.
  floats.forEach { shader.setFloatUniform(it, 0f) }
  return AndroidCompiledShader(shader, floats)
}

@RequiresApi(33)
private class AndroidCompiledShader(
  private val shader: RuntimeShader,
  override val floatUniforms: Set<String>,
) : PrototypeCompiledShader {
  override fun effect(uniforms: Map<String, Double>): RenderEffect {
    val values = prototypeShaderUniformValues(floatUniforms, uniforms)
    values.forEach { (name, value) -> shader.setFloatUniform(name, value) }
    return android.graphics.RenderEffect.createRuntimeShaderEffect(shader, "content")
      .asComposeRenderEffect()
  }
}
