package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow

/** Platform sensors only. Constructing or closing an unused source never touches the context. */
internal class AndroidSensorSource(private val context: Context) : PrototypeSensorSource {
  private val manager by lazy { context.getSystemService(SensorManager::class.java) }
  private val cancellations = mutableSetOf<() -> Unit>()
  private var closed = false

  override val stepsGranted: Boolean
    get() =
      Build.VERSION.SDK_INT < 29 ||
        ContextCompat.checkSelfPermission(context, Manifest.permission.ACTIVITY_RECOGNITION) ==
          PackageManager.PERMISSION_GRANTED

  override fun hasSensor(sensor: PrototypeSensor) = manager.getDefaultSensor(sensor.type()) != null

  override fun samples(sensor: PrototypeSensor, rateHz: Int): Flow<PrototypeSensorSample> =
    callbackFlow {
      require(rateHz in 1..30)
      val listener =
        object : SensorEventListener {
          override fun onSensorChanged(event: SensorEvent) {
            val at = event.timestamp / 1_000_000
            val sample =
              when (sensor) {
                PrototypeSensor.ORIENTATION -> {
                  val rotation = FloatArray(9)
                  SensorManager.getRotationMatrixFromVector(rotation, event.values)
                  PrototypeSensorSample.Values(
                    at,
                    orientationDegrees(SensorManager.getOrientation(rotation, FloatArray(3))),
                  )
                }
                PrototypeSensor.LIGHT ->
                  PrototypeSensorSample.Values(at, mapOf("lightLux" to event.values[0].toDouble()))
                PrototypeSensor.STEPS ->
                  PrototypeSensorSample.Values(at, mapOf("steps" to event.values[0].toDouble()))
                PrototypeSensor.PROXIMITY ->
                  PrototypeSensorSample.Proximity(
                    at,
                    proximityNear(event.values[0], event.sensor.maximumRange),
                  )
                PrototypeSensor.SHAKE ->
                  PrototypeSensorSample.Acceleration(
                    at,
                    event.values[0].toDouble(),
                    event.values[1].toDouble(),
                    event.values[2].toDouble(),
                  )
              }
            trySend(sample)
          }

          override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit
        }
      val cancel: () -> Unit = { close() }
      var attempted = false
      val teardown = {
        synchronized(cancellations) {
          cancellations -= cancel
          if (attempted) {
            manager.unregisterListener(listener)
            attempted = false
          }
        }
      }
      try {
        synchronized(cancellations) {
          if (closed || (sensor == PrototypeSensor.STEPS && !stepsGranted)) {
            close()
          } else {
            val deviceSensor = manager.getDefaultSensor(sensor.type())
            val period =
              if (sensor == PrototypeSensor.SHAKE) SensorManager.SENSOR_DELAY_GAME
              else 1_000_000 / rateHz
            if (deviceSensor == null) close()
            else {
              attempted = true
              if (
                manager.registerListener(
                  listener,
                  deviceSensor,
                  period,
                  Handler(Looper.getMainLooper()),
                )
              )
                cancellations += cancel
              else close()
            }
          }
        }
        awaitClose { teardown() }
      } finally {
        // Registration may throw after partial setup, before awaitClose installs its handler.
        teardown()
      }
    }

  override fun close() {
    val pending =
      synchronized(cancellations) {
        closed = true
        cancellations.toList()
      }
    pending.forEach { it() }
  }
}

private fun PrototypeSensor.type(): Int =
  when (this) {
    PrototypeSensor.ORIENTATION -> Sensor.TYPE_ROTATION_VECTOR
    PrototypeSensor.LIGHT -> Sensor.TYPE_LIGHT
    PrototypeSensor.PROXIMITY -> Sensor.TYPE_PROXIMITY
    PrototypeSensor.STEPS -> Sensor.TYPE_STEP_COUNTER
    PrototypeSensor.SHAKE -> Sensor.TYPE_ACCELEROMETER
  }

/** SensorManager.getOrientation returns azimuth, pitch and roll in radians, in that order. */
internal fun orientationDegrees(angles: FloatArray): Map<String, Double> =
  mapOf(
    "pitchDeg" to Math.toDegrees(angles[1].toDouble()),
    "rollDeg" to Math.toDegrees(angles[2].toDouble()),
    "headingDeg" to Math.toDegrees(angles[0].toDouble()),
  )

internal fun proximityNear(value: Float, maximumRange: Float): Boolean = value < maximumRange
