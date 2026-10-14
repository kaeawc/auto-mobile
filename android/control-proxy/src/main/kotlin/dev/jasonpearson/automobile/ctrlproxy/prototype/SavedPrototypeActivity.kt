package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.ctrlproxy.CtrlProxyTheme
import dev.jasonpearson.automobile.ctrlproxy.R
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/**
 * Standalone activity renderer: no service, idle timer, disconnect or foreground-app scoping. Back
 * and authored dismissal emit one user dismissal. System process death emits nothing.
 */
class SavedPrototypeActivity : ComponentActivity() {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
  private val interactions = Mutex()
  private var state by mutableStateOf<SavedPrototypeScreenState>(SavedPrototypeScreenState.Loading)
  private var runtime: PrototypeRuntime? = null
  private var images: PrototypeImageCache? = null
  private var fonts: PrototypeFontCache? = null
  private var sequence = 0L

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    onBackPressedDispatcher.addCallback(
      this,
      object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
          scope.launch { interactions.withLock { dismiss() } }
        }
      },
    )
    setContent {
      CtrlProxyTheme {
        val current = runtime
        if (state is SavedPrototypeScreenState.Ready && current != null) {
          Surface(Modifier.fillMaxSize().testTag("saved-prototype-state-ready")) {
            PrototypeRuntimeContent(current, images, fonts) { interact(it) }
          }
        } else SavedPrototypeStatus(state) { finish() }
      }
    }
    scope.launch {
      val loadedState = withContext(SavedPrototypeActivityDependencies.ioDispatcher) { loadState() }
      if (isFinishing) return@launch
      if (loadedState is SavedPrototypeScreenState.Ready) prepareRuntime(loadedState.loaded)
      state = loadedState
    }
  }

  private suspend fun loadState(): SavedPrototypeScreenState {
    val id = SavedPrototypeLaunch.idFrom(intent)
    if (id.isNullOrBlank()) return SavedPrototypeScreenState.MissingId
    return try {
      if (!SavedPrototypeActivityDependencies.isUserUnlocked(this)) SavedPrototypeScreenState.Locked
      else loadSavedPrototypeState(id, SavedPrototypeActivityDependencies.store(this)) { true }
    } catch (error: CancellationException) {
      throw error
    } catch (error: Exception) {
      Log.w("SavedPrototypeActivity", "Saved prototype storage unavailable", error)
      SavedPrototypeScreenState.Corrupt
    }
  }

  private fun prepareRuntime(loaded: SavedPrototypeLoadResult.Loaded) {
    val source = SavedPrototypeAssetSource(loaded)
    images =
      PrototypeImageCache(
        source,
        BitmapPrototypeImageDecoder(),
        dispatcher = SavedPrototypeActivityDependencies.ioDispatcher,
      )
    fonts = PrototypeFontCache(source, ComposePrototypeFontLoader())
    runtime =
      PrototypeRuntime(
        loaded.spec,
        SavedPrototypeActivityDependencies.eventSink,
        SavedPrototypeActivityDependencies.clock,
        nextSequence = { ++sequence },
        requestDismiss = {
          finish()
          true
        },
      )
  }

  internal suspend fun interact(interaction: PrototypeInteraction) = interactions.withLock {
    try {
      runtime?.handle(interaction)
    } catch (error: CancellationException) {
      throw error
    } catch (error: Exception) {
      Log.w("SavedPrototypeActivity", "Prototype interaction failed", error)
    }
  }

  private suspend fun dismiss() {
    runtime?.dismiss(PrototypeDismissReason.USER)
    finish()
  }

  override fun onDestroy() {
    scope.cancel()
    runtime?.close()
    super.onDestroy()
  }
}

@Composable
private fun SavedPrototypeStatus(state: SavedPrototypeScreenState, close: () -> Unit) {
  val title =
    when (state) {
      SavedPrototypeScreenState.MissingId -> R.string.saved_prototype_missing_id
      SavedPrototypeScreenState.NotSaved -> R.string.saved_prototype_not_saved
      SavedPrototypeScreenState.Corrupt -> R.string.saved_prototype_corrupt
      is SavedPrototypeScreenState.Unsupported -> R.string.saved_prototype_unsupported
      SavedPrototypeScreenState.Locked -> R.string.saved_prototype_locked
      else -> null
    }
  val tag =
    when (state) {
      SavedPrototypeScreenState.MissingId -> "missing-id"
      SavedPrototypeScreenState.NotSaved -> "not-saved"
      SavedPrototypeScreenState.Corrupt -> "corrupt"
      is SavedPrototypeScreenState.Unsupported -> "unsupported"
      SavedPrototypeScreenState.Locked -> "locked"
      else -> "loading"
    }
  Surface(Modifier.fillMaxSize().testTag("saved-prototype-state-$tag")) {
    if (title != null)
      Column(
        modifier = Modifier.fillMaxSize().padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
      ) {
        Text(stringResource(title), style = MaterialTheme.typography.titleLarge)
        Text(
          if (state is SavedPrototypeScreenState.Unsupported)
            stringResource(R.string.saved_prototype_version, state.version)
          else stringResource(R.string.saved_prototype_error_body),
        )
        Button(onClick = close, modifier = Modifier.testTag("saved-prototype-close")) {
          Text(stringResource(R.string.saved_prototype_close))
        }
      }
  }
}
