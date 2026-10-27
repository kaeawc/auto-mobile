package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.os.Build
import android.util.Log
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.GraphicsLayerScope
import androidx.compose.ui.graphics.RenderEffect
import androidx.compose.ui.graphics.graphicsLayer
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import dev.jasonpearson.automobile.protocol.PrototypeShader
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.withContext

/** Installed once at the prototype root, never in a node's uniform/asset effect. */
@Composable
internal fun PrototypeShaderFrameSampling(session: PrototypeShaderSession) {
  val lifecycle = LocalLifecycleOwner.current.lifecycle
  val owner = remember(session) { Any() }
  DisposableEffect(session, lifecycle, owner) {
    fun update() =
      session.setVisible(lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED), owner)
    val observer = LifecycleEventObserver { _, _ -> update() }
    lifecycle.addObserver(observer)
    update()
    onDispose {
      lifecycle.removeObserver(observer)
      session.removeSampler(owner)
    }
  }
  LaunchedEffect(session, owner) {
    session.samplingOwner.collectLatest { activeOwner ->
      if (activeOwner === owner) {
        try {
          while (withFrameNanos { session.frame(it, owner) }) {
            // One signal for all active shaders; frame time cannot attribute GPU work to a node.
          }
        } finally {
          session.pause(owner)
        }
      }
    }
  }
}

@Composable
internal fun Modifier.prototypeShader(
  node: PrototypeRenderNode,
  dispatcher: CoroutineDispatcher = Dispatchers.IO,
): Modifier {
  val shader = node.style.source.shader ?: return this
  val session = LocalPrototypeShaderSession.current ?: return this
  // Deliberately not keyed by authored identity: repeat keys need independent failure guards.
  val registration = remember(session) { session.register(node.identity) }
  DisposableEffect(session, registration) { onDispose { session.unregister(registration) } }
  val state =
    remember(session, registration) {
      PrototypeShaderEffectState(
        session,
        registration,
        AndroidPrototypeShaderCompiler(),
        { compiled, uniforms -> compiled.effect(uniforms) },
        { stage, error ->
          Log.w("PrototypeShader", "Shader $stage failed for ${node.identity}", error)
        },
      )
    }
  val revision by session.revision.collectAsState()
  // Read the revision to subscribe to synchronous node failures and the prototype-wide budget.
  val disabled = remember(revision, state) { state.disabled }
  if (disabled) return this
  if (Build.VERSION.SDK_INT < 33) {
    registration.guard.disable(
      "Custom AGSL shaders need API 33 or newer; content is drawn unshaded.",
    )
    return this
  }
  val effect = rememberPrototypeShaderEffect(shader, dispatcher, state)
  PrototypeShaderActivity(session, registration, effect != null && node.visible)
  if (effect == null) return this
  return drawWithContent { state.draw { drawContent() } }
    .graphicsLayer { prototypeShaderLayer(effect, state.disabled) }
}

@Composable
private fun rememberPrototypeShaderEffect(
  shader: PrototypeShader,
  dispatcher: CoroutineDispatcher,
  state: PrototypeShaderEffectState<RenderEffect>,
): RenderEffect? {
  val source = LocalPrototypeImageCache.current?.source
  val version = LocalPrototypeImageVersion.current
  val compiled by
    key(state, source, shader.asset, version) {
      produceState<PrototypeCompiledShader?>(null) {
        value = withContext(dispatcher) { state.prepare(source, shader.asset, version) }
      }
    }
  return remember(state, compiled, shader.uniforms) {
    compiled?.let { state.effect(it, shader) }
  }
}

/** Device-free layer configuration shared by the compositor and JVM tests. */
internal fun GraphicsLayerScope.prototypeShaderLayer(effect: RenderEffect, disabled: Boolean) {
  clip = true
  renderEffect = if (disabled) null else effect
}

/** Retained ancestors can keep a shader composed while omitting its entire subtree from drawing. */
internal val LocalPrototypeShadersVisible = compositionLocalOf { true }

@Composable
internal fun PrototypeShaderActivity(
  session: PrototypeShaderSession,
  registration: PrototypeShaderSession.Registration,
  visible: Boolean,
) {
  val active = visible && LocalPrototypeShadersVisible.current
  DisposableEffect(session, registration, active) {
    session.setActive(registration, active)
    onDispose { session.setActive(registration, false) }
  }
}
