package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeShader
import kotlinx.coroutines.CancellationException

internal class PrototypeShaderAssetUnavailable(message: String) : IllegalStateException(message)

internal fun compilePrototypeShaderAsset(
  source: PrototypeAssetSource?,
  asset: String,
  compiler: PrototypeShaderCompiler,
): PrototypeCompiledShader {
  val info =
    source?.lookup(asset, shader = true)
      ?: throw PrototypeShaderAssetUnavailable("Shader asset '$asset' is missing; upload it again.")
  require(info.mimeType == "application/vnd.automobile.agsl") {
    "Shader asset '$asset' must have AGSL MIME type."
  }
  val bytes =
    source.read(asset, shader = true)
      ?: throw PrototypeShaderAssetUnavailable(
        "Shader asset '$asset' is unreadable; upload it again.",
      )
  val text = bytes.toString(Charsets.UTF_8)
  require(text.toByteArray(Charsets.UTF_8).contentEquals(bytes)) {
    "AGSL source must be valid UTF-8."
  }
  return compiler.compile(text).getOrThrow()
}

/** The preparation/effect boundary used by Compose, also executable with a device-free effect. */
internal class PrototypeShaderEffectState<Effect>(
  private val session: PrototypeShaderSession,
  private val registration: PrototypeShaderSession.Registration,
  private val compiler: PrototypeShaderCompiler,
  private val createEffect: (PrototypeCompiledShader, Map<String, Double>) -> Effect,
  private val report: (String, Throwable) -> Unit = { _, _ -> },
) {
  private data class Key(val source: PrototypeAssetSource?, val asset: String, val version: Long?)

  private var key: Key? = null
  private var compiled: PrototypeCompiledShader? = null

  val disabled: Boolean
    get() = registration.guard.disabledReason != null || session.disabledReason != null

  @Synchronized
  fun prepare(
    source: PrototypeAssetSource?,
    asset: String,
    version: Long?,
  ): PrototypeCompiledShader? {
    if (disabled) return null
    val next = Key(source, asset, version)
    if (key != next) {
      val prepared = attempt("compile") { compilePrototypeShaderAsset(source, asset, compiler) }
      key = next
      compiled = prepared
    }
    return compiled
  }

  fun effect(compiled: PrototypeCompiledShader, shader: PrototypeShader): Effect? =
    attempt("effect") {
      val uniforms = shader.uniforms.orEmpty()
      prototypeShaderUniformValues(compiled.floatUniforms, uniforms)
      createEffect(compiled, uniforms)
    }

  fun draw(block: () -> Unit) {
    // Fallback content still draws after a failure; the graphics layer removes its effect.
    attempt("draw", allowDisabled = true, block = block)
  }

  private fun <T> attempt(stage: String, allowDisabled: Boolean = false, block: () -> T): T? {
    if (disabled && !allowDisabled) return null
    return runCatching(block).getOrElse { error ->
      // This renderer boundary handles synchronous exceptions, never cancellation or fatal errors.
      if (error !is Exception || error is CancellationException) throw error
      report(stage, error)
      if (error !is PrototypeShaderAssetUnavailable) {
        registration.guard.disable(
          "Shader $stage failed: ${error.message ?: error.javaClass.simpleName}",
        )
      }
      null
    }
  }
}
