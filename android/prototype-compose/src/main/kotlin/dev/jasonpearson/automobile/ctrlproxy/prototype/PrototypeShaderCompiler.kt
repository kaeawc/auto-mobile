package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.os.Build
import androidx.compose.ui.graphics.RenderEffect

/** Compilation is injectable: JVM tests never instantiate a GPU-backed Android object. */
@InternalAutoMobilePrototypeApi
fun interface PrototypeShaderCompiler {
  fun compile(source: String): Result<PrototypeCompiledShader>
}

@InternalAutoMobilePrototypeApi
interface PrototypeCompiledShader {
  val floatUniforms: Set<String>

  /** A fresh, node-owned effect; implementations set only validated scalar float uniforms. */
  fun effect(uniforms: Map<String, Double>): RenderEffect
}

@InternalAutoMobilePrototypeApi
class PrototypeShaderCompileException(val reason: PrototypeAssetRejection, message: String) :
  IllegalArgumentException(message)

/**
 * API checks and lexical preflight precede the platform call, including for direct device clients.
 */
@InternalAutoMobilePrototypeApi
class AndroidPrototypeShaderCompiler(
  private val apiLevel: () -> Int = { Build.VERSION.SDK_INT },
  private val platformCompile: (String, Set<String>) -> PrototypeCompiledShader =
    { source, floats ->
      compileOnDevice(source, floats)
    },
) : PrototypeShaderCompiler {
  override fun compile(source: String): Result<PrototypeCompiledShader> = runCatching {
    if (apiLevel() < 33) {
      throw PrototypeShaderCompileException(
        PrototypeAssetRejection.SHADER_UNSUPPORTED_API,
        "Custom AGSL shader support needs API 33 or newer; use an Android 13+ device or remove style.shader.",
      )
    }
    val declarations = prototypeShaderDeclarations(source)
    // RenderEffect requires the named content input even for a procedural shader that ignores it.
    val program = if (declarations.content) source else "uniform shader content;\n$source"
    try {
      platformCompile(program, declarations.floats)
    } catch (error: IllegalArgumentException) {
      if (declarations.content) throw error
      throw IllegalArgumentException(prototypeShaderSourceError(error.message.orEmpty()), error)
    }
  }
}

internal fun prototypeShaderUniformValues(
  declared: Set<String>,
  supplied: Map<String, Double>,
): Map<String, Float> {
  require(supplied.size <= 16) { "Custom AGSL shaders permit at most 16 float uniforms." }
  val values = supplied.mapValues { (name, value) ->
    require(name in declared) {
      "AGSL uniform '$name' is not declared as a scalar float in the compiled source."
    }
    require(value.isFinite()) { "AGSL uniform '$name' must be finite." }
    value.coerceIn(-1_000_000.0, 1_000_000.0).toFloat()
  }
  return declared.associateWith { values[it] ?: 0f }
}

/** Same whole-code-point, 2 KiB UTF-8 cap as the host's boundedPrototypeError. */
internal fun boundedPrototypeShaderError(message: String): String {
  var end = 0
  var bytes = 0
  while (end < message.length) {
    val point = message.codePointAt(end)
    val size =
      when {
        point <= 0x7f -> 1
        point <= 0x7ff -> 2
        point <= 0xffff -> 3
        else -> 4
      }
    if (bytes + size > 2048) break
    bytes += size
    end += Character.charCount(point)
  }
  return message.substring(0, end)
}

@InternalAutoMobilePrototypeApi
fun prototypeShaderCapabilities(apiLevel: Int): Set<String> =
  if (apiLevel >= 33) setOf("prototype_custom_shaders_v1") else emptySet()

private fun compileOnDevice(source: String, floats: Set<String>): PrototypeCompiledShader {
  if (Build.VERSION.SDK_INT >= 33) return compileAndroidPrototypeShader(source, floats)
  throw PrototypeShaderCompileException(
    PrototypeAssetRejection.SHADER_UNSUPPORTED_API,
    "Custom AGSL shader support needs API 33 or newer.",
  )
}
