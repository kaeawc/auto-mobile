package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.content.Intent
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
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidation
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidator
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/**
 * Standalone activity renderer: no service, idle timer, disconnect or foreground-app scoping. Back
 * and authored dismissal emit one user dismissal. System process death emits nothing. Document
 * relaunches reload the saved snapshot, closing the previous runtime without an event.
 */
class SavedPrototypeActivity : ComponentActivity() {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
  private val interactions = Mutex()
  private var state by mutableStateOf<SavedPrototypeScreenState>(SavedPrototypeScreenState.Loading)
  private var runtime: PrototypeRuntime? = null
  private var images: PrototypeImageCache? = null
  private var fonts: PrototypeFontCache? = null

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
            PrototypeRuntimeContent(current, images, fonts) { interact(it, current) }
          }
        } else SavedPrototypeStatus(state) { finish() }
      }
    }
    reload(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    reload(intent)
  }

  private fun reload(intent: Intent?) {
    val id = SavedPrototypeLaunch.idFrom(intent)
    scope.launch {
      interactions.withLock {
        if (isFinishing) return@withLock
        runtime?.flushStorage()
        runtime?.close()
        runtime = null
        images = null
        fonts = null
        state = SavedPrototypeScreenState.Loading
        val loadedState =
          withContext(SavedPrototypeActivityDependencies.ioDispatcher) { loadState(id) }
        if (isFinishing) return@withLock
        if (loadedState is SavedPrototypeScreenState.Ready) prepareRuntime(loadedState.loaded)
        state = loadedState
      }
    }
  }

  private suspend fun loadState(id: String?): SavedPrototypeScreenState {
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

  private suspend fun prepareRuntime(loaded: SavedPrototypeLoadResult.Loaded) {
    val source = SavedPrototypeAssetSource(loaded)
    images =
      PrototypeImageCache(
        source,
        BitmapPrototypeImageDecoder(),
        dispatcher = SavedPrototypeActivityDependencies.ioDispatcher,
      )
    fonts = PrototypeFontCache(source, ComposePrototypeFontLoader())
    // The stored values replace the saved spec's before the first draw, as for a shown prototype.
    val opened =
      PrototypeStoragePersistence(
          SavedPrototypeActivityDependencies.storageStore(this),
          CoroutinePrototypeScheduler(scope),
          SavedPrototypeActivityDependencies.ioDispatcher,
          registry = PrototypeStorageSessionRegistry.Shared,
        )
        .prepare(loaded.spec) { restored ->
          PrototypeSpecValidator.validate(Json.encodeToString(restored)) is
            PrototypeSpecValidation.Success
        }
    opened.commit()
    runtime =
      PrototypeRuntime(
        opened.spec,
        SavedPrototypeActivityDependencies.eventSink,
        SavedPrototypeActivityDependencies.clock,
        nextSequence = { SavedPrototypeEvents.nextSequence(loaded.spec.id) },
        requestDismiss = {
          finish()
          true
        },
        storage = opened.session,
      )
  }

  internal suspend fun interact(
    interaction: PrototypeInteraction,
    target: PrototypeRuntime? = runtime,
  ) = interactions.withLock {
    if (target !== runtime) return@withLock
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

  /** The last point a stopped activity is sure to run: write what the debounce still holds. */
  override fun onStop() {
    // Not on [scope]: onDestroy cancels it, and a stop followed by a destroy must still save.
    val target = runtime
    SavedPrototypeActivityDependencies.flushScope.launch {
      withContext(NonCancellable) { interactions.withLock { target?.flushStorage() } }
    }
    super.onStop()
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
