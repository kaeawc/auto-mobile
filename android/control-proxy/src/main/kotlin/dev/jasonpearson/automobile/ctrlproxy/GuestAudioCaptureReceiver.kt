package dev.jasonpearson.automobile.ctrlproxy

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.BadParcelableException
import android.os.SystemClock
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/** Ordered replies are synchronous; all blocking PCM reads run on the controller's reader. */
class GuestAudioCaptureReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != ACTION) return
    val op = intent.getStringExtra("op")
    val reply =
      controller(context).handle(op, intent.getStringExtra("lease"), leaseTimeout(intent, op))
    resultCode = 0
    resultData = reply
  }

  private fun leaseTimeout(intent: Intent, op: String?): Long? {
    if (op != "start") return null
    return try {
      if (!intent.hasExtra("leaseTimeoutMs")) return null
      // A wrong-typed extra can return the fallback instead of throwing; zero is invalid.
      intent.getLongExtra("leaseTimeoutMs", 0L)
    } catch (error: BadParcelableException) {
      android.util.Log.w("GuestAudioCapture", "Unreadable lease timeout", error)
      0L
    } catch (error: ClassCastException) {
      android.util.Log.w("GuestAudioCapture", "Unreadable lease timeout", error)
      0L
    }
  }

  private companion object {
    const val ACTION = "dev.jasonpearson.automobile.GUEST_AUDIO_CAPTURE"
    private var instance: GuestAudioCaptureController? = null

    @Synchronized
    fun controller(context: Context): GuestAudioCaptureController =
      instance
        ?: GuestAudioCaptureController(AndroidGuestAudioCapturePort(context.applicationContext))
          .also { instance = it }
  }
}

private class AndroidGuestAudioCapturePort(private val context: Context) : GuestAudioCapturePort {
  private val timeouts =
    ScheduledThreadPoolExecutor(1) { runnable ->
        Thread(runnable, "guest-audio-timeout").apply { isDaemon = true }
      }
      .apply { removeOnCancelPolicy = true }

  override fun hasRecordAudioPermission(): Boolean =
    context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) ==
      PackageManager.PERMISSION_GRANTED

  override fun nowMs(): Long = SystemClock.elapsedRealtime()

  override fun createRecord(): GuestAudioCaptureRecord {
    val bufferSize =
      AudioRecord.getMinBufferSize(
        SAMPLE_RATE,
        AudioFormat.CHANNEL_IN_MONO,
        AudioFormat.ENCODING_PCM_16BIT,
      )
    check(bufferSize > 0) { "invalid AudioRecord minimum buffer size: $bufferSize" }
    if (
      context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) !=
        PackageManager.PERMISSION_GRANTED
    ) {
      throw IllegalStateException(
        "RECORD_AUDIO is not granted to CtrlProxy; reinstall the CtrlProxy APK",
      )
    }
    val record =
      AudioRecord(
        MediaRecorder.AudioSource.MIC,
        SAMPLE_RATE,
        AudioFormat.CHANNEL_IN_MONO,
        AudioFormat.ENCODING_PCM_16BIT,
        bufferSize,
      )
    return object : GuestAudioCaptureRecord {
      private val buffer = ByteArray(bufferSize)

      override fun start() {
        check(record.state == AudioRecord.STATE_INITIALIZED) { "AudioRecord is not initialized" }
        record.startRecording()
      }

      override fun isRecording(): Boolean =
        record.recordingState == AudioRecord.RECORDSTATE_RECORDING

      override fun read(): Int = record.read(buffer, 0, buffer.size, AudioRecord.READ_BLOCKING)

      override fun stop() {
        if (record.recordingState == AudioRecord.RECORDSTATE_RECORDING) record.stop()
      }

      override fun release() = record.release()
    }
  }

  override fun launchReader(read: () -> Unit): GuestAudioCaptureReader {
    val exited = CountDownLatch(1)
    thread(name = "guest-audio-capture", isDaemon = true) {
      try {
        read()
      } finally {
        exited.countDown()
      }
    }
    return GuestAudioCaptureReader { timeoutMs -> exited.await(timeoutMs, TimeUnit.MILLISECONDS) }
  }

  override fun schedule(delayMs: Long, task: () -> Unit): () -> Unit {
    val future = timeouts.schedule({ task() }, delayMs, TimeUnit.MILLISECONDS)
    return { future.cancel(false) }
  }

  private companion object {
    const val SAMPLE_RATE = 48_000
  }
}
