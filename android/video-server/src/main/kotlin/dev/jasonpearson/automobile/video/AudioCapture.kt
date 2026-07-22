package dev.jasonpearson.automobile.video

import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Captures device playback audio as 8 kHz mono PCM16LE.
 *
 * This runs from the shell-owned app_process video server. It uses REMOTE_SUBMIX, which is
 * privileged and may be unavailable on some builds; in that case start() throws and the TypeScript
 * caller reports a clear stream startup failure for audio-enabled sessions.
 */
class AudioCapture(
  private val sampleRate: Int = SAMPLE_RATE_HZ,
  private val channels: Int = CHANNELS,
) {
  private var record: AudioRecord? = null
  private var thread: Thread? = null
  private val running = AtomicBoolean(false)

  fun start(onData: (ByteArray, Long) -> Boolean, onError: (String) -> Unit = {}) {
    if (running.getAndSet(true)) {
      throw IllegalStateException("Audio capture already started")
    }

    val minBuffer =
      AudioRecord.getMinBufferSize(
        sampleRate,
        AudioFormat.CHANNEL_IN_MONO,
        AudioFormat.ENCODING_PCM_16BIT,
      )
    val bufferSize = if (minBuffer > 0) minBuffer * 2 else sampleRate * channels * BYTES_PER_SAMPLE

    val audioFormat =
      AudioFormat.Builder()
        .setSampleRate(sampleRate)
        .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
        .build()

    val recorder =
      AudioRecord.Builder()
        .setAudioSource(MediaRecorder.AudioSource.REMOTE_SUBMIX)
        .setAudioFormat(audioFormat)
        .setBufferSizeInBytes(bufferSize)
        .build()

    if (recorder.state != AudioRecord.STATE_INITIALIZED) {
      running.set(false)
      recorder.release()
      throw IllegalStateException("AudioRecord REMOTE_SUBMIX failed to initialize")
    }

    try {
      recorder.startRecording()
      record = recorder
    } catch (e: RuntimeException) {
      running.set(false)
      recorder.release()
      throw e
    }
    thread =
      Thread(
          {
            val buffer = ByteArray(bufferSize)
            val startedAtUs = System.nanoTime() / 1_000L
            try {
              while (running.get()) {
                val read = recorder.read(buffer, 0, buffer.size)
                if (read > 0) {
                  val ptsUs = (System.nanoTime() / 1_000L) - startedAtUs
                  if (!onData(buffer.copyOf(read), ptsUs)) {
                    running.set(false)
                    break
                  }
                } else if (read < 0) {
                  running.set(false)
                  onError("AudioRecord read failed with code $read")
                  break
                }
              }
            } catch (e: RuntimeException) {
              if (running.get()) {
                running.set(false)
                onError("AudioRecord read failed: ${e.message}")
              }
            }
          },
          "automobile-audio-capture",
        )
        .also { it.start() }
  }

  fun stop() {
    running.set(false)
    try {
      record?.stop()
    } catch (_: IllegalStateException) {}
    try {
      thread?.join(1_000)
    } catch (_: InterruptedException) {
      Thread.currentThread().interrupt()
    }
    record?.release()
    record = null
    thread = null
  }

  companion object {
    const val SAMPLE_RATE_HZ = 8_000
    const val CHANNELS = 1
    private const val BYTES_PER_SAMPLE = 2
  }
}
