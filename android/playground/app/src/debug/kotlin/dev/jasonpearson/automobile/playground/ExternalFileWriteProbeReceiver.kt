package dev.jasonpearson.automobile.playground

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import java.io.File
import java.io.IOException

/** DUMP-guarded external storage write probe packaged only in debug builds. */
class ExternalFileWriteProbeReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != ACTION_TEST_WRITE_EXTERNAL_FILE) return

    try {
      val directory =
        checkNotNull(context.getExternalFilesDir(null)) { "External files unavailable" }
      if (!directory.isDirectory && !directory.mkdirs()) {
        throw IOException("Could not create external files directory")
      }
      val file = File(directory, "automobile-write-probe.txt")
      file.writeBytes("probe".toByteArray(Charsets.UTF_8))
      if (!file.delete()) {
        throw IOException("Could not delete external write probe")
      }
      resultCode = Activity.RESULT_OK
      resultData = "WRITE_OK"
    } catch (error: IOException) {
      handleWriteFailure(error)
    } catch (error: SecurityException) {
      handleWriteFailure(error)
    } catch (error: IllegalStateException) {
      handleWriteFailure(error)
    }
  }

  private fun handleWriteFailure(error: Exception) {
    val message = "WRITE_FAILED ${error.javaClass.simpleName}: ${error.message}"
    Log.e("ExternalFileWriteProbe", message, error)
    resultCode = Activity.RESULT_CANCELED
    resultData = message
  }

  companion object {
    const val ACTION_TEST_WRITE_EXTERNAL_FILE =
      "dev.jasonpearson.automobile.playground.action.TEST_WRITE_EXTERNAL_FILE"
  }
}
