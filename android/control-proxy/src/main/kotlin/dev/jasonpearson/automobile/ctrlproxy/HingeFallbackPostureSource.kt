package dev.jasonpearson.automobile.ctrlproxy

import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Build
import android.os.Handler
import dev.jasonpearson.automobile.ctrlproxy.DeviceStateTransitions.FoldPosture
import dev.jasonpearson.automobile.ctrlproxy.DeviceStateTransitions.Kind
import dev.jasonpearson.automobile.ctrlproxy.DeviceStateTransitions.PostureSource
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CancellationException

internal fun interface HingeAngleSource {
  /** Returns null when hinge-angle observation is unavailable. */
  fun observe(onAngle: (Float) -> Unit): AutoCloseable?
}

/**
 * Thresholds mirror the pixel_fold AVD posture definitions: 0-30 closed, 30-150 half-open, and
 * 150-180 flat. They are only a heuristic used when WindowManager is silent.
 */
private const val HALF_OPEN_MIN_DEGREES = 30f
private const val FLAT_MIN_DEGREES = 150f

internal fun hingeAnglePostures(angleDegrees: Float): List<FoldPosture>? =
  when {
    angleDegrees.isNaN() || angleDegrees < 0f -> null
    angleDegrees < HALF_OPEN_MIN_DEGREES -> emptyList()
    angleDegrees < FLAT_MIN_DEGREES -> listOf(FoldPosture(Kind.HALF_OPENED, isSeparating = true))
    else -> listOf(FoldPosture(Kind.FLAT, isSeparating = false))
  }

internal class SensorHingeAngleSource(
  private val sensorManager: SensorManager?,
  private val handler: Handler?,
) : HingeAngleSource {
  override fun observe(onAngle: (Float) -> Unit): AutoCloseable? {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return null
    val manager = sensorManager ?: return null
    val sensor = manager.getDefaultSensor(Sensor.TYPE_HINGE_ANGLE) ?: return null
    val listener =
      object : SensorEventListener {
        override fun onSensorChanged(event: SensorEvent) {
          event.values.firstOrNull()?.let(onAngle)
        }

        override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit
      }
    if (!manager.registerListener(listener, sensor, SensorManager.SENSOR_DELAY_NORMAL, handler)) {
      return null
    }
    return AutoCloseable { manager.unregisterListener(listener) }
  }
}

internal class HingeFallbackPostureSource(
  private val primary: PostureSource,
  private val hinge: HingeAngleSource,
  private val info: (String) -> Unit,
  private val warn: (String, Throwable?) -> Unit,
) : PostureSource {
  override fun observe(onPostures: (List<FoldPosture>) -> Unit): AutoCloseable {
    val closed = AtomicBoolean(false)
    val primaryActive = AtomicBoolean(false)
    val firstLayout = AtomicBoolean(true)
    val initialEmptyLogged = AtomicBoolean(false)
    val fallbackLogged = AtomicBoolean(false)

    fun closeRegistration(name: String, registration: AutoCloseable?) {
      try {
        registration?.close()
      } catch (e: CancellationException) {
        throw e
      } catch (e: Exception) {
        warn("fold-posture $name source close failed", e)
      } catch (e: LinkageError) {
        warn("fold-posture $name source close failed", e)
      }
    }

    val primaryRegistration: AutoCloseable? =
      try {
        primary.observe { postures ->
          if (!closed.get()) {
            if (firstLayout.compareAndSet(true, false)) {
              info("WindowManager first layout: ${postures.size} folding feature(s)")
            }
            if (postures.isNotEmpty()) {
              if (primaryActive.compareAndSet(false, true)) {
                info("WindowManager reported a folding feature; hinge-angle fallback disabled")
              }
              onPostures(postures)
            } else if (primaryActive.get()) {
              onPostures(postures)
            } else if (initialEmptyLogged.compareAndSet(false, true)) {
              info(
                "WindowManager reported no folding feature (initial layout); hinge-angle fallback stays armed",
              )
            }
          }
        }
      } catch (e: CancellationException) {
        closed.set(true)
        throw e
      } catch (e: Exception) {
        warn("fold-posture primary source failed; relying on hinge-angle fallback", e)
        null
      } catch (e: LinkageError) {
        warn("fold-posture primary source failed; relying on hinge-angle fallback", e)
        null
      }

    val hingeRegistration: AutoCloseable? =
      try {
        hinge
          .observe { angle ->
            if (!closed.get() && !primaryActive.get()) {
              hingeAnglePostures(angle)?.let { postures ->
                if (fallbackLogged.compareAndSet(false, true)) {
                  info("WindowManager silent; using hinge-angle fallback (angle=$angle)")
                }
                onPostures(postures)
              }
            }
          }
          .also {
            if (it == null) {
              info("no hinge-angle sensor; fold posture depends on WindowManager only")
            }
          }
      } catch (e: CancellationException) {
        closed.set(true)
        closeRegistration("primary", primaryRegistration)
        throw e
      } catch (e: Exception) {
        warn("fold-posture hinge-angle source failed; relying on WindowManager only", e)
        null
      } catch (e: LinkageError) {
        warn("fold-posture hinge-angle source failed; relying on WindowManager only", e)
        null
      }

    return AutoCloseable {
      if (closed.compareAndSet(false, true)) {
        try {
          closeRegistration("primary", primaryRegistration)
        } finally {
          closeRegistration("hinge-angle", hingeRegistration)
        }
      }
    }
  }
}
