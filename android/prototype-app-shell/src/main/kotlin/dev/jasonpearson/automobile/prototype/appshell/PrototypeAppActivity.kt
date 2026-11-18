package dev.jasonpearson.automobile.prototype.appshell

import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.lifecycle.lifecycleScope
import dev.jasonpearson.automobile.ctrlproxy.prototype.AndroidBiometricSource
import dev.jasonpearson.automobile.ctrlproxy.prototype.AndroidLocationSource
import dev.jasonpearson.automobile.ctrlproxy.prototype.AndroidPermissionsSource
import dev.jasonpearson.automobile.ctrlproxy.prototype.InternalAutoMobilePrototypeApi
import dev.jasonpearson.automobile.ctrlproxy.prototype.LocalPrototypeRootBack
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeBiometricModule
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeLocationModule
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypePermissionsModule
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeRuntime
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeSecureStorageModule
import dev.jasonpearson.automobile.prototype.AutoMobilePrototype
import dev.jasonpearson.automobile.prototype.EmbeddedPrototypeHost
import dev.jasonpearson.automobile.prototype.PrototypeAssets
import dev.jasonpearson.automobile.prototype.PrototypePlatform
import dev.jasonpearson.automobile.prototype.PrototypeStorage
import dev.jasonpearson.automobile.prototype.ProvideEmbeddedPrototypeHost
import java.io.IOException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

@OptIn(InternalAutoMobilePrototypeApi::class)
class PrototypeAppActivity : ComponentActivity() {
  private val interactions = Mutex()
  private val links = AppShellLinkInbox()
  private var runtime: PrototypeRuntime? = null
  // A stop followed by destroy must finish saving after lifecycleScope is cancelled.
  private val storageFlushScope by lazy {
    CoroutineScope(lifecycleScope.coroutineContext + NonCancellable)
  }
  private val host by lazy {
    EmbeddedPrototypeHost(lifecycleScope, interactions).also { host ->
      host.flushScope = storageFlushScope
      host.onRuntime = { runtime = it }
      host.initializeRuntime = { runtime ->
        val metadata =
          packageManager.getActivityInfo(componentName, PackageManager.GET_META_DATA).metaData
        runtime.registeredLinkSchemes =
          metadata?.getString("automobile.prototype.linkSchemes")?.split(',').orEmpty()
        links.attach(runtime::openLink)
      }
    }
  }
  private val generation = mutableIntStateOf(0)
  private val remountGate = ResumedRemountGate { generation.intValue++ }

  override fun onCreate(savedInstanceState: Bundle?) {
    installSplashScreen()
    super.onCreate(savedInstanceState)
    lifecycle.addObserver(remountGate)
    intent?.dataString?.let { url ->
      lifecycleScope.launch { interactions.withLock { links.receive(url) } }
    }
    val source = ApkPrototypeSource(assets)
    val loader = AppShellLoader(source, PrototypeStorage.fileBacked(this))
    val prototypeAssets = PrototypeAssets(image = source::readAsset, font = source::readAsset)
    setContent {
      MaterialTheme {
        ProvideEmbeddedPrototypeHost(host) { AppContent(loader, prototypeAssets) }
      }
    }
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    intent.dataString?.let { url ->
      lifecycleScope.launch { interactions.withLock { links.receive(url) } }
    }
  }

  override fun onStop() {
    val target = runtime
    storageFlushScope.launch(start = CoroutineStart.UNDISPATCHED) {
      interactions.withLock {
        try {
          target?.pauseTimers()
          target?.flushStorage()
        } catch (error: IOException) {
          Log.w("PrototypeAppShell", "Cannot flush prototype storage", error)
        } catch (error: SecurityException) {
          Log.w("PrototypeAppShell", "Cannot flush prototype storage", error)
        }
      }
    }
    super.onStop()
  }

  override fun onDestroy() {
    runtime?.close()
    runtime = null
    links.detach()
    super.onDestroy()
  }

  @Composable
  private fun AppContent(
    loader: AppShellLoader,
    prototypeAssets: PrototypeAssets,
    ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
  ) {
    val state by
      produceState<AppShellState>(AppShellState.Loading, loader) {
        value =
          withContext(ioDispatcher) {
            try {
              loader.load()
            } catch (error: IOException) {
              Log.w("PrototypeAppShell", "Cannot read stamped prototype spec", error)
              AppShellState.CorruptSpec
            }
          }
      }
    val platform =
      remember(this) {
        PrototypePlatform(
          listOf(
            PrototypeLocationModule(AndroidLocationSource(this)),
            PrototypeBiometricModule(AndroidBiometricSource(this)),
            PrototypePermissionsModule(AndroidPermissionsSource(this)),
            PrototypeSecureStorageModule.fileBacked(this),
          ),
        )
      }
    DisposableEffect(platform) {
      onDispose { platform.registry.modules.forEach { it.close() } }
    }
    Surface(Modifier.fillMaxSize()) {
      val current = state
      if (current is AppShellState.Ready) {
        // Root Back only backgrounds the task, so the renderer and its unsaved state stay alive.
        CompositionLocalProvider(LocalPrototypeRootBack provides { moveTaskToBack(true) }) {
          key(generation.intValue) {
            AutoMobilePrototype(
              platform = platform,
              spec = current.spec,
              assets = prototypeAssets,
              storage = loader.storage,
              handleBack = true,
              onDismiss = {
                links.detach()
                // Any other user dismissal ends the session; remount so returning is not blank, but
                // only once the activity resumes so onAppear never runs while backgrounding.
                if (appShellBackAction(depth = 1) == AppShellBackAction.MOVE_TASK_TO_BACK) {
                  if (moveTaskToBack(true)) remountGate.requestAfterBackgrounding()
                  else generation.intValue++
                }
              },
            )
          }
        }
      } else AppShellStatus(current) { moveTaskToBack(true) }
    }
  }
}
