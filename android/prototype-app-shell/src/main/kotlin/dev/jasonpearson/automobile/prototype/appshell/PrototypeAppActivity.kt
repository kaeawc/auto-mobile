package dev.jasonpearson.automobile.prototype.appshell

import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import dev.jasonpearson.automobile.prototype.AutoMobilePrototype
import dev.jasonpearson.automobile.prototype.PrototypeAssets
import dev.jasonpearson.automobile.prototype.PrototypeStorage
import java.io.IOException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class PrototypeAppActivity : ComponentActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    installSplashScreen()
    super.onCreate(savedInstanceState)
    val source = ApkPrototypeSource(assets)
    val loader = AppShellLoader(source, PrototypeStorage.fileBacked(this))
    val prototypeAssets = PrototypeAssets(image = source::readAsset, font = source::readAsset)
    setContent {
      MaterialTheme {
        AppContent(loader, prototypeAssets)
      }
    }
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
    var generation by remember { mutableIntStateOf(0) }
    Surface(Modifier.fillMaxSize()) {
      val current = state
      if (current is AppShellState.Ready) {
        key(generation) {
          AutoMobilePrototype(
            spec = current.spec,
            assets = prototypeAssets,
            storage = loader.storage,
            handleBack = true,
            onDismiss = {
              // The renderer consumes Back at depth > 1 before emitting a dismissal.
              if (appShellBackAction(depth = 1) == AppShellBackAction.MOVE_TASK_TO_BACK) {
                moveTaskToBack(true)
                generation++
              }
            },
          )
        }
      } else AppShellStatus(current) { moveTaskToBack(true) }
    }
  }
}
