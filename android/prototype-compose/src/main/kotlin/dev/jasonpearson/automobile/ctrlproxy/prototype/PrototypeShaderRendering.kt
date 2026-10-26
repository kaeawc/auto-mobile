package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.os.Build
import android.util.Log
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.RenderEffect
import androidx.compose.ui.graphics.graphicsLayer
import dev.jasonpearson.automobile.protocol.PrototypeShader
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

private class PrototypeShaderAssetUnavailable(message: String) : IllegalStateException(message)

/** A separate compilation per node prevents uniform writes leaking into another node's shader. */
internal fun prototypeShaderEffect(
  source: PrototypeAssetSource?,
  shader: PrototypeShader,
  compiler: PrototypeShaderCompiler,
): RenderEffect {
  val info =
    source?.lookup(shader.asset)
      ?: throw PrototypeShaderAssetUnavailable(
        "Shader asset '${shader.asset}' is missing; upload it again.",
      )
  require(info.mimeType == "application/vnd.automobile.agsl") {
    "Shader asset '${shader.asset}' must have AGSL MIME type."
  }
  val bytes =
    source.read(shader.asset)
      ?: throw PrototypeShaderAssetUnavailable(
        "Shader asset '${shader.asset}' is unreadable; upload it again.",
      )
  val text = bytes.toString(Charsets.UTF_8)
  require(text.toByteArray(Charsets.UTF_8).contentEquals(bytes)) {
    "AGSL source must be valid UTF-8."
  }
  val compiled = compiler.compile(text).getOrThrow()
  val uniforms = shader.uniforms.orEmpty()
  // Check the complete map before setting any uniform, including with injected compilers.
  prototypeShaderUniformValues(compiled.floatUniforms, uniforms)
  return compiled.effect(uniforms)
}

@Composable
internal fun prototypeShaderModifier(
  node: PrototypeRenderNode,
  dispatcher: CoroutineDispatcher = Dispatchers.IO,
): Modifier {
  val shader = node.style.source.shader ?: return Modifier
  val session = LocalPrototypeShaderSession.current ?: return Modifier
  val guard = remember(session, node.identity) { session.guard(node.identity) }
  var disabled by remember(guard) { mutableStateOf(guard.disabledReason != null) }
  if (disabled) return Modifier
  if (Build.VERSION.SDK_INT < 33) {
    guard.disable("Custom AGSL shaders need API 33 or newer; content is drawn unshaded.")
    return Modifier
  }
  val effect =
    rememberPrototypeShaderEffect(shader, dispatcher, guard, node.identity) { disabled = true }
  LaunchedEffect(guard, effect) {
    if (effect != null) {
      val sample: (Long) -> Boolean = { guard.frame(it) }
      try {
        while (withFrameNanos(sample)) {
          /* Frame timestamps, never wall-clock work duration. */
        }
        disabled = true
      } finally {
        // A hidden/disposed node must not count its time off-screen as a slow frame.
        guard.pause()
      }
    }
  }
  if (effect == null) return Modifier
  return Modifier.drawWithContent {
      runCatching { drawContent() }
        .onFailure { error ->
          if (error is CancellationException) throw error
          shaderFailure(guard, node.identity, "draw", error)
          disabled = true
        }
      // Failure removes the effect on the next frame; never retry a failing layer here.
    }
    .graphicsLayer { renderEffect = if (guard.disabledReason == null) effect else null }
}

@Composable
private fun rememberPrototypeShaderEffect(
  shader: PrototypeShader,
  dispatcher: CoroutineDispatcher,
  guard: PrototypeShaderFrameGuard,
  identity: String,
  onFailure: () -> Unit,
): RenderEffect? {
  val source = LocalPrototypeImageCache.current?.source
  val version = LocalPrototypeImageVersion.current
  val compiler = remember { AndroidPrototypeShaderCompiler() }
  val effect by
    key(source, shader, version) {
      produceState<RenderEffect?>(null) {
        runCatching { withContext(dispatcher) { prototypeShaderEffect(source, shader, compiler) } }
          .onSuccess { value = it }
          .onFailure { error ->
            when (error) {
              is CancellationException -> throw error
              is PrototypeShaderAssetUnavailable -> {
                // Expected missingAssets/re-upload path: retry when the asset version changes.
                Log.w("PrototypeShader", error.message.orEmpty())
              }
              else -> {
                shaderFailure(guard, identity, "compile/effect", error)
                onFailure()
              }
            }
          }
      }
    }
  return effect
}

private fun shaderFailure(
  guard: PrototypeShaderFrameGuard,
  identity: String,
  stage: String,
  error: Throwable,
) {
  Log.w("PrototypeShader", "Shader $stage failed for node $identity", error)
  guard.disable("Shader $stage failed: ${error.message ?: error.javaClass.simpleName}")
}
