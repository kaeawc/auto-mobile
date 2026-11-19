package dev.jasonpearson.automobile.prototype.appshell

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import java.io.File
import java.io.IOException
import java.util.concurrent.Executors
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
    val journalFile = File(application.filesDir, "attach-journal.json")
    return AppAttachProcess(
        token,
        scope,
        log = log,
        journal = FileAttachJournal(journalFile, installIdentity(application), log),
        journalExecutor =
          Executors.newSingleThreadExecutor {
            Thread(it, "attach-journal").apply { isDaemon = true }
          },
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

  // Every install, including an in-place `adb install -r`, sets a new last update time.
  private fun installIdentity(context: Context): String {
    val manager = context.packageManager
    val info =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        manager.getPackageInfo(context.packageName, PackageManager.PackageInfoFlags.of(0))
      } else {
        @Suppress("DEPRECATION") manager.getPackageInfo(context.packageName, 0)
      }
    return "lastUpdateTime:${info.lastUpdateTime}"
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
