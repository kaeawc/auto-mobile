package dev.jasonpearson.automobile.prototype.appshell

import android.content.Context
import android.util.Log
import java.io.File
import java.io.IOException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

/**
 * Application-context-only listener and delivery scope, retained until Android kills the process.
 */
internal object AndroidAppAttachProcess {
  private var process: AppAttachProcess? = null

  // Activity lifecycle callbacks and the attach agent are confined to Main.immediate.
  fun get(context: Context): AppAttachProcess {
    process?.let {
      return it
    }
    val application = context.applicationContext
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    val token = asset(application, "attach-token")
    val allowPhysicalDevice = asset(application, "attach-allow-physical-device") == "true"
    val log: (String) -> Unit = { Log.w("PrototypeAppShell", it) }
    return AppAttachProcess(
        token,
        scope,
        log = log,
        journal = FileAttachJournal(File(application.filesDir, "attach-journal.json"), log),
        startListener = { agent ->
          AppAttachServer.start(
            application.packageName,
            agent,
            scope,
            policy = AttachDevicePolicy(AndroidAttachDeviceEnvironment, allowPhysicalDevice),
          )
        },
      )
      .also { process = it }
  }

  private fun asset(context: Context, name: String): String? =
    try {
      context.assets.open("prototype/$name").bufferedReader(Charsets.UTF_8).use {
        it.readText().trim()
      }
    } catch (_: IOException) {
      // Unstamped templates and emulator-only stamps intentionally omit these optional assets.
      Log.d("PrototypeAppShell", "Optional attach asset unavailable: $name")
      null
    }
}
