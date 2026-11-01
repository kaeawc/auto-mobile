package dev.jasonpearson.automobile.playground

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import java.io.File
import java.io.IOException

/** DUMP-guarded file corruption probe packaged only in debug builds. */
class AppFileReadProbeReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != ACTION_READ) return
    try {
      val path = requireNotNull(intent.getStringExtra("file")) { "Missing file extra" }
      require(path.isNotBlank() && !path.startsWith('/') && !path.contains("..")) {
        "file must be relative to the app data directory without .."
      }
      val dataDir = File(context.applicationInfo.dataDir).canonicalFile
      val file = File(dataDir, path).canonicalFile
      require(file.path.startsWith(dataDir.path + File.separator)) {
        "file must stay inside the app data directory"
      }
      AppFileReader()
        .read(file, intent.getBooleanExtra("seed", false))
        .fold(
          onSuccess = { detail ->
            resultCode = Activity.RESULT_OK
            resultData = "READ_OK $detail"
          },
          onFailure = { error -> handleFailure(error) },
        )
    } catch (error: IllegalArgumentException) {
      handleFailure(error)
    } catch (error: IOException) {
      handleFailure(error)
    } catch (error: SecurityException) {
      handleFailure(error)
    }
  }

  private fun handleFailure(error: Throwable) {
    resultCode = Activity.RESULT_CANCELED
    resultData = "READ_FAILED ${error.javaClass.simpleName}: ${error.message}"
    Log.e("AppFileReadProbe", resultData, error)
  }

  companion object {
    const val ACTION_READ = "dev.jasonpearson.automobile.playground.action.TEST_READ_APP_FILE"
  }
}
