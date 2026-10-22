package dev.jasonpearson.automobile.protoviewer

import android.util.Log
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Recomposer
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import kotlinx.coroutines.CancellationException

/** An app-owned composition boundary; fakes can withhold readiness without blocking main. */
interface ViewerRenderer {
  @Composable fun Render(content: @Composable () -> Unit, onFailure: () -> Unit)
}

/**
 * A failed spec composition must not take down the app composition containing Back and provenance.
 * Its own recomposer catches composition failures once, then the activity removes this surface.
 */
object GuardedViewerRenderer : ViewerRenderer {
  @Composable
  @Suppress(
    "TooGenericExceptionCaught",
  ) // Arbitrary spec composition failures share this recovery boundary.
  override fun Render(content: @Composable () -> Unit, onFailure: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val render by rememberUpdatedState(content)
    val failed by rememberUpdatedState(onFailure)
    val recomposer = remember { Recomposer(scope.coroutineContext) }
    val view = remember {
      ComposeView(context).apply { setParentCompositionContext(recomposer) }
    }
    AndroidView(factory = { view }, modifier = Modifier.fillMaxSize())
    DisposableEffect(view) {
      onDispose {
        view.disposeComposition()
        recomposer.cancel()
      }
    }
    LaunchedEffect(view) {
      try {
        view.setContent { ProtoViewerTheme { render() } }
        recomposer.runRecomposeAndApplyChanges()
      } catch (error: CancellationException) {
        throw error
      } catch (error: RuntimeException) {
        Log.w("ProtoViewer", "Prototype composition failed", error)
        failed()
      }
    }
  }
}
