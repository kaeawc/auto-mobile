package dev.jasonpearson.automobile.protoviewer

import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.lifecycleScope
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeRuntime
import dev.jasonpearson.automobile.prototype.AutoMobilePrototype
import dev.jasonpearson.automobile.prototype.EmbeddedPrototypeHost
import dev.jasonpearson.automobile.prototype.PrototypeAssets
import dev.jasonpearson.automobile.prototype.PrototypeNetwork
import dev.jasonpearson.automobile.prototype.PrototypeStorage
import dev.jasonpearson.automobile.prototype.ProvideEmbeddedPrototypeHost
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

class ViewerActivity : ComponentActivity() {
  private val services
    get() = (application as ProtoViewerApplication).services

  private val interactions = Mutex()
  private var runtime: PrototypeRuntime? = null
  private var content by mutableStateOf<ViewerContent?>(null)
  private var state by mutableStateOf<ViewerScreenState>(ViewerScreenState.Loading)
  private var confirmReset by mutableStateOf(false)
  private var restartFailed by mutableStateOf(false)
  private var restarting by mutableStateOf(false)
  private var libraryId: String? = null
  private val restart: suspend (Boolean) -> Unit = { reset -> relaunch(reset) }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    libraryId = intent.getStringExtra(ViewerLaunch.LIBRARY_ID)
    libraryId?.let { services.register(it, restart) }
    setContent { ProtoViewerTheme { ViewerScreen() } }
    lifecycleScope.launch {
      state = withContext(services.io) { loadViewer(libraryId, services.repository) }
      if (!isFinishing && !restarting)
        (state as? ViewerScreenState.Ready)?.let { prepare(it.prototype) }
    }
  }

  private fun prepare(prototype: LibraryPrototype) {
    val host =
      EmbeddedPrototypeHost(lifecycleScope, interactions, services.io).apply {
        clock = services.clock::nowMillis
        flushScope = services.flushScope
        isCurrent = { content?.host === this && !isFinishing && !restarting }
        onRuntime = { opened -> if (isCurrent()) runtime = opened else opened.close() }
      }
    content = ViewerContent(prototype, services.storage.namespace(prototype.entry.libraryId), host)
  }

  @Composable
  private fun ViewerScreen() {
    Column(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing)) {
      // The renderer is measured only in the remaining space; specs cannot cover these actions.
      Row(Modifier.fillMaxWidth().testTag("viewer-actions")) {
        TextButton(onClick = { lifecycleScope.launch { relaunch(false) } }, enabled = !restarting) {
          Text(stringResource(R.string.relaunch))
        }
        TextButton(onClick = { confirmReset = true }, enabled = !restarting) {
          Text(stringResource(R.string.reset))
        }
      }
      if (restartFailed) Text(stringResource(R.string.action_error))
      Box(Modifier.weight(1f).fillMaxWidth().clipToBounds().testTag("viewer-content")) {
        val current = content
        if (current == null) ViewerStatus(state) { finish() }
        else
          ProvideEmbeddedPrototypeHost(current.host) {
            AutoMobilePrototype(
              spec = current.prototype.saved.specJson,
              modifier = Modifier.fillMaxSize().testTag("viewer-ready"),
              assets = current.assets,
              storage = current.storage,
              network = current.network,
              handleBack = true,
              onDismiss = { finish() },
              onError = {
                SideEffect {
                  content = null
                  state = ViewerScreenState.Error(LibraryError.Corrupt)
                }
              },
            )
          }
      }
    }
    if (confirmReset)
      ResetConfirmation({ confirmReset = false }) {
        confirmReset = false
        lifecycleScope.launch { relaunch(true) }
      }
  }

  private suspend fun relaunch(reset: Boolean) = interactions.withLock {
    if (restarting || isFinishing) return@withLock
    val id = libraryId ?: return@withLock
    restarting = true
    try {
      runtime?.flushStorage()
    } catch (error: CancellationException) {
      throw error
    } catch (_: Exception) {
      restarting = false
      restartFailed = true
      return@withLock
    }
    runtime?.close()
    runtime = null
    content = null
    val result =
      withContext(services.io) {
        if (reset) services.repository.resetStorage(id) else LibraryResult.Success(Unit)
      }
    if (result is LibraryResult.Failure) {
      restarting = false
      restartFailed = true
      state = ViewerScreenState.Error(result.error)
      return@withLock
    }
    finishAndRemoveTask()
    ViewerLaunch.open(this, id, relaunch = true)
  }

  override fun onStop() {
    val target = runtime
    services.flushScope.launch {
      withContext(NonCancellable) {
        interactions.withLock {
          try {
            target?.flushStorage()
          } catch (error: IOException) {
            Log.w("ProtoViewer", "Cannot flush prototype storage", error)
          } catch (error: SecurityException) {
            Log.w("ProtoViewer", "Cannot flush prototype storage", error)
          }
        }
      }
    }
    super.onStop()
  }

  override fun onDestroy() {
    libraryId?.let { services.unregister(it, restart) }
    runtime?.close()
    super.onDestroy()
  }
}

private class ViewerContent(
  val prototype: LibraryPrototype,
  val storage: PrototypeStorage,
  val host: EmbeddedPrototypeHost,
) {
  val assets =
    PrototypeAssets(image = prototype.saved::assetBytes, font = prototype.saved::assetBytes)
  val network = PrototypeNetwork(device = DeniedPrototypeHttpClient)
}

@Composable
internal fun ViewerStatus(state: ViewerScreenState, back: () -> Unit) {
  Column(Modifier.fillMaxSize()) {
    val error = state as? ViewerScreenState.Error
    val title =
      when (error?.reason) {
        LibraryError.NotFound -> R.string.not_found
        LibraryError.UnsupportedFormat -> R.string.unsupported
        null -> R.string.loading
        else -> R.string.corrupt
      }
    Text(stringResource(title), modifier = Modifier.testTag("viewer-status"))
    if (error != null) Button(onClick = back) { Text(stringResource(R.string.back)) }
  }
}
