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
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.ctrlproxy.CtrlProxyTheme
import dev.jasonpearson.automobile.ctrlproxy.R
import dev.jasonpearson.automobile.prototype.AutoMobilePrototype
import dev.jasonpearson.automobile.prototype.EmbeddedPrototypeHost
import dev.jasonpearson.automobile.prototype.PrototypeAssets
import dev.jasonpearson.automobile.prototype.PrototypeNetwork
import dev.jasonpearson.automobile.prototype.PrototypeStorage
import dev.jasonpearson.automobile.prototype.ProvideEmbeddedPrototypeHost
import dev.jasonpearson.automobile.prototype.prototypeHostStorage
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.isActive
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
  private var content by mutableStateOf<SavedPrototypeContent?>(null)

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
        val current = content
        if (current != null) SavedContent(current) else SavedPrototypeStatus(state) { finish() }
      }
    }
    reload(intent)
  }

  @Composable
  private fun SavedContent(current: SavedPrototypeContent) {
    val ready = state is SavedPrototypeScreenState.Ready
    val tag = if (ready) Modifier.testTag("saved-prototype-state-ready") else Modifier
    Surface(Modifier.fillMaxSize().then(tag)) {
      // A document relaunch must replace even an identical spec, without a dismissal.
      key(current) {
        ProvideEmbeddedPrototypeHost(current.host) {
          AutoMobilePrototype(
            spec = current.spec,
            assets = current.assets,
            storage = current.storage,
            network = current.network,
            onEvent = { if (current.host.eventSink == null) SavedPrototypeEvents.send(it) },
            onDismiss = { finish() },
            handleBack = true,
            onError = {
              SideEffect {
                content = null
                state = SavedPrototypeScreenState.Corrupt
              }
            },
          )
        }
      }
      // Keep the loading screen and withhold the ready tag until storage has restored. Opening
      // underneath it publishes the runtime before the first content draw.
      if (!ready) SavedPrototypeStatus(state) { finish() }
    }
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
        content = null
        state = SavedPrototypeScreenState.Loading
        val loadedState =
          withContext(SavedPrototypeActivityDependencies.ioDispatcher) { loadState(id) }
        if (isFinishing) return@withLock
        if (loadedState is SavedPrototypeScreenState.Ready) prepareContent(loadedState.loaded)
        else state = loadedState
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

  private fun prepareContent(loaded: SavedPrototypeLoadResult.Loaded) {
    val source = SavedPrototypeAssetSource(loaded)
    val host =
      EmbeddedPrototypeHost(scope, interactions, SavedPrototypeActivityDependencies.ioDispatcher)
        .apply {
          clock = SavedPrototypeActivityDependencies.clock
          nextSequence = SavedPrototypeEvents::nextSequence
          storageRegistry = PrototypeStorageSessionRegistry.Shared
          flushScope = SavedPrototypeActivityDependencies.flushScope
          // Default delivery uses public onEvent. Await injected suspending sinks inside the
          // runtime so consecutive events cannot overtake one another.
          eventSink =
            SavedPrototypeActivityDependencies.eventSink.takeUnless {
              it === SavedPrototypeActivityDependencies.defaultEventSink
            }
          requestDismiss = {
            finish()
            true
          }
          isCurrent = { content?.host === this && !isFinishing && scope.isActive }
          onRuntime = { opened ->
            if (isCurrent()) {
              runtime = opened
              state = SavedPrototypeScreenState.Ready(loaded)
            } else opened.close()
          }
          onInteraction = { interaction, target -> interact(interaction, target) }
        }
    content =
      SavedPrototypeContent(
        // Serialize the validated model: test stores and replaced documents need not keep their
        // original JSON text in sync with the immutable saved snapshot.
        Json.encodeToString(loaded.spec),
        PrototypeAssets(image = source::read, font = source::read),
        prototypeHostStorage(SavedPrototypeActivityDependencies.storageStore(this)),
        SavedPrototypeActivityDependencies.network(),
        host,
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

  override fun onStart() {
    super.onStart()
    scope.launch(start = CoroutineStart.UNDISPATCHED) {
      interactions.withLock { runtime?.resumeTimers() }
    }
  }

  /** The last point a stopped activity is sure to run: write what the debounce still holds. */
  override fun onStop() {
    // Not on [scope]: onDestroy cancels it, and a stop followed by a destroy must still save.
    val target = runtime
    SavedPrototypeActivityDependencies.flushScope.launch(start = CoroutineStart.UNDISPATCHED) {
      withContext(NonCancellable) {
        interactions.withLock {
          target?.pauseTimers()
          target?.flushStorage()
        }
      }
    }
    super.onStop()
  }

  override fun onDestroy() {
    scope.cancel()
    runtime?.close()
    super.onDestroy()
  }
}

private class SavedPrototypeContent(
  val spec: String,
  val assets: PrototypeAssets,
  val storage: PrototypeStorage,
  val network: PrototypeNetwork,
  val host: EmbeddedPrototypeHost,
)

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
