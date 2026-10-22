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
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.lifecycleScope
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeHttpClient
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeHttpRequest
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeRuntime
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeScheduledTask
import dev.jasonpearson.automobile.prototype.AutoMobilePrototype
import dev.jasonpearson.automobile.prototype.EmbeddedPrototypeHost
import dev.jasonpearson.automobile.prototype.PrototypeAssets
import dev.jasonpearson.automobile.prototype.PrototypeHttpClient as EmbeddedHttpClient
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
  private var watchdog: PrototypeScheduledTask? = null
  private var renderFailed = false
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
    watchdog = services.renderWatchdog.start(lifecycleScope) { failRender() }
    lifecycleScope.launch {
      val loaded = withContext(services.io) { loadViewer(libraryId, services.repository) }
      if (!isFinishing && !restarting && !renderFailed) {
        state = loaded
        if (loaded is ViewerScreenState.Ready) prepare(loaded.prototype) else stopWatchdog()
      }
    }
  }

  private fun prepare(prototype: LibraryPrototype) {
    val host =
      EmbeddedPrototypeHost(lifecycleScope, interactions, services.io).apply {
        clock = services.clock::nowMillis
        flushScope = services.flushScope
        isCurrent = { content?.host === this && !isFinishing && !restarting && !renderFailed }
        onRuntime = { opened -> if (isCurrent()) runtime = opened else opened.close() }
        onReady = { if (isCurrent()) stopWatchdog() }
      }
    content =
      ViewerContent(
        prototype,
        services.storage.namespace(prototype.entry.libraryId),
        host,
        services.networkClient,
      )
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
      val allowNetwork by services.settings.allowNetwork.collectAsState()
      if (allowNetwork)
        Text(
          stringResource(R.string.network_provenance),
          modifier = Modifier.fillMaxWidth().testTag("network-provenance"),
        )
      if (restartFailed) Text(stringResource(R.string.action_error))
      // Spec dialogs, menus, dropdowns, sheets and anchored overlays are all in-window renderer
      // layers. Clip that whole surface, including its scrims, below the app-owned provenance.
      Box(Modifier.weight(1f).fillMaxWidth().clipToBounds().testTag("viewer-content")) {
        val current = content
        if (current == null) ViewerStatus(state) { finish() }
        else
          services.renderer.Render(
            onFailure = { failRender() },
            content = {
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
                      failRender()
                    }
                  },
                )
              }
            },
          )
      }
    }
    if (confirmReset)
      ResetConfirmation({ confirmReset = false }) {
        confirmReset = false
        lifecycleScope.launch { relaunch(true) }
      }
  }

  private fun stopWatchdog() {
    watchdog?.cancel()
    watchdog = null
  }

  private fun failRender() {
    if (renderFailed || isFinishing || restarting) return
    renderFailed = true
    stopWatchdog()
    runtime?.close()
    runtime = null
    content = null
    state = ViewerScreenState.Error(LibraryError.Corrupt)
  }

  private suspend fun relaunch(reset: Boolean) = interactions.withLock {
    if (restarting || isFinishing) return@withLock
    val id = libraryId ?: return@withLock
    restarting = true
    stopWatchdog()
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
    stopWatchdog()
    libraryId?.let { services.unregister(it, restart) }
    runtime?.close()
    super.onDestroy()
  }
}

private class ViewerContent(
  val prototype: LibraryPrototype,
  val storage: PrototypeStorage,
  val host: EmbeddedPrototypeHost,
  client: PrototypeHttpClient,
) {
  val assets =
    PrototypeAssets(image = prototype.saved::assetBytes, font = prototype.saved::assetBytes)
  // The embedded renderer exposes a read-only request facade; the saved transport consumes
  // the shared runtime contract. Preserve every resolved field at this app boundary.
  val network =
    PrototypeNetwork(
      device =
        EmbeddedHttpClient { request ->
          client.execute(
            PrototypeHttpRequest(
              request.requestId,
              request.prototypeId,
              request.method,
              request.url,
              request.headers,
              request.body,
              request.timeoutMs,
            ),
          )
        },
    )
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
