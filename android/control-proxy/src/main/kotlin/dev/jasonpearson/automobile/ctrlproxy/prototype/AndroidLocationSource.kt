package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.Manifest
import android.annotation.SuppressLint
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.location.LocationRequest
import android.os.Build
import android.os.Bundle
import android.os.CancellationSignal
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import androidx.core.content.ContextCompat
import androidx.core.location.LocationManagerCompat
import java.util.concurrent.Executor
import kotlin.coroutines.resume
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.suspendCancellableCoroutine

/** Platform providers only: no Play services. Construction never touches the context. */
internal class AndroidLocationSource(private val context: Context) : PrototypeLocationSource {
  private val manager by lazy { context.getSystemService(LocationManager::class.java) }
  private val enabled = MutableStateFlow(false)
  // Enabled platform providers; each change re-selects the provider of every live subscription.
  private val enabledProviders = MutableStateFlow<Set<String>>(emptySet())
  // Bumped by close() so every subscription's provider loop observes `closed` and ends.
  private val closings = MutableStateFlow(0)
  private var registered = false
  private val cancellations = mutableSetOf<() -> Unit>()
  @Volatile private var closed = false
  override val grant: PrototypeLocationGrant
    get() =
      when {
        granted(Manifest.permission.ACCESS_FINE_LOCATION) -> PrototypeLocationGrant.PRECISE
        granted(Manifest.permission.ACCESS_COARSE_LOCATION) -> PrototypeLocationGrant.APPROXIMATE
        else -> PrototypeLocationGrant.NONE
      }

  override val servicesEnabled: StateFlow<Boolean>
    get() {
      start()
      return enabled.asStateFlow()
    }

  private val receiver =
    object : BroadcastReceiver() {
      override fun onReceive(context: Context, intent: Intent) {
        refresh()
      }
    }

  /** Re-reads mode and provider state; a provider toggle keeps location on but moves selection. */
  private fun refresh() {
    // getProviders(true) drops providers the caller lacks permission for on older releases, so a
    // snapshot taken before a grant would stay empty; isProviderEnabled reads the setting alone.
    val providers =
      manager.allProviders.filterTo(mutableSetOf()) {
        it in ALL_PROVIDERS && manager.isProviderEnabled(it)
      }
    enabledProviders.value = providers
    enabled.value = LocationManagerCompat.isLocationEnabled(manager) && providers.isNotEmpty()
  }

  @Synchronized
  private fun start() {
    if (registered || closed) return
    refresh()
    ContextCompat.registerReceiver(
      context,
      receiver,
      IntentFilter(LocationManager.MODE_CHANGED_ACTION).apply {
        addAction(LocationManager.PROVIDERS_CHANGED_ACTION)
      },
      ContextCompat.RECEIVER_NOT_EXPORTED,
    )
    registered = true
  }

  private fun granted(permission: String) =
    ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

  private fun provider(accuracy: PrototypeLocationAccuracy): String? {
    start()
    return locationProvider(
      Build.VERSION.SDK_INT,
      accuracy,
      grant,
      manager.allProviders,
      enabledProviders.value,
    )
  }

  @SuppressLint("MissingPermission") // The module checks grants; revocation propagates as denial.
  override suspend fun current(accuracy: PrototypeLocationAccuracy, maxAgeMs: Long): LocationFix? {
    check(!closed) { "Location source closed" }
    val provider = provider(accuracy)
    if (maxAgeMs > 0 && provider != null) {
      val cached = manager.getLastKnownLocation(provider)
      if (cached != null) {
        val age = (SystemClock.elapsedRealtimeNanos() - cached.elapsedRealtimeNanos) / 1_000_000
        if (age in 0..maxAgeMs) return reading(cached)
      }
    }
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
      // Re-selects when the provider turns off; the module ends the wait if services turn off.
      return updates(accuracy, 1000, 0.0).firstOrNull()
    }
    // No enabled provider: report no fix now instead of waiting for the dispatcher timeout.
    if (provider == null) return null
    return suspendCancellableCoroutine { continuation ->
      val signal = CancellationSignal()
      val cancel: () -> Unit = {
        signal.cancel()
        continuation.cancel()
      }
      synchronized(cancellations) { cancellations += cancel }
      continuation.invokeOnCancellation {
        signal.cancel()
        synchronized(cancellations) { cancellations -= cancel }
      }
      try {
        manager.getCurrentLocation(provider, signal, Executor { it.run() }) { location ->
          synchronized(cancellations) { cancellations -= cancel }
          if (continuation.isActive) continuation.resume(location?.let(::reading))
        }
      } catch (@Suppress("TooGenericExceptionCaught") error: RuntimeException) {
        synchronized(cancellations) { cancellations -= cancel }
        Log.w(TAG, "Current location failed: ${error.javaClass.simpleName}")
        throw error
      }
    }
  }

  @SuppressLint("MissingPermission") // Permission races fail the flow and become typed denial.
  override fun updates(
    accuracy: PrototypeLocationAccuracy,
    minIntervalMs: Long,
    minDistanceM: Double,
  ): Flow<LocationFix> = channelFlow {
    check(!closed) { "Location source closed" }
    val listener =
      object : LocationListener {
        override fun onLocationChanged(location: Location) {
          trySend(reading(location))
        }

        // Toggles re-read provider state so the selection below moves off a disabled provider.
        override fun onProviderEnabled(provider: String) = refresh()

        override fun onProviderDisabled(provider: String) = refresh()

        @Deprecated("Not delivered on Android Q and later")
        override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) = Unit
      }
    var selected: String? = null
    try {
      start()
      combine(enabledProviders, closings) { _, _ -> provider(accuracy) }
        .takeWhile { !closed }
        .distinctUntilChanged()
        .collect { next ->
          if (selected != null) manager.removeUpdates(listener)
          selected = next
          if (next != null) register(next, accuracy, minIntervalMs, minDistanceM, listener)
        }
    } finally {
      try {
        manager.removeUpdates(listener)
      } catch (error: SecurityException) {
        Log.w(TAG, "Location listener cleanup permission denied: ${error.javaClass.simpleName}")
      }
    }
  }

  @SuppressLint("MissingPermission") // Callers run inside updates(), which types denial.
  private fun register(
    provider: String,
    accuracy: PrototypeLocationAccuracy,
    minIntervalMs: Long,
    minDistanceM: Double,
    listener: LocationListener,
  ) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      val request =
        LocationRequest.Builder(minIntervalMs)
          .setMinUpdateIntervalMillis(minIntervalMs)
          .setMinUpdateDistanceMeters(minDistanceM.toFloat())
          .setQuality(
            if (
              accuracy == PrototypeLocationAccuracy.PRECISE &&
                grant == PrototypeLocationGrant.PRECISE
            )
              LocationRequest.QUALITY_HIGH_ACCURACY
            else LocationRequest.QUALITY_BALANCED_POWER_ACCURACY,
          )
          .build()
      manager.requestLocationUpdates(provider, request, Executor { it.run() }, listener)
    } else {
      manager.requestLocationUpdates(
        provider,
        minIntervalMs,
        minDistanceM.toFloat(),
        listener,
        Looper.getMainLooper(),
      )
    }
  }

  @Synchronized
  override fun close() {
    closed = true
    closings.value++
    val pending =
      synchronized(cancellations) { cancellations.toList().also { cancellations.clear() } }
    pending.forEach { it() }
    if (registered) {
      try {
        context.unregisterReceiver(receiver)
      } catch (error: IllegalArgumentException) {
        Log.w(TAG, "Location receiver was already unregistered", error)
      } finally {
        registered = false
      }
    }
  }

  private fun reading(location: Location) =
    LocationFix(
      latitude = location.latitude,
      longitude = location.longitude,
      accuracyM = if (location.hasAccuracy()) location.accuracy.toDouble() else Double.NaN,
      timestampMs = location.time,
      approximate = grant == PrototypeLocationGrant.APPROXIMATE,
      altitudeM = if (location.hasAltitude()) location.altitude else null,
      speedMps = if (location.hasSpeed()) location.speed.toDouble() else null,
      bearingDeg = if (location.hasBearing()) location.bearing.toDouble() else null,
    )

  private companion object {
    const val TAG = "PrototypeLocation"
  }
}

/** Kept pure so provider routing can be checked without Android or a device. */
internal fun locationProvider(
  sdk: Int,
  accuracy: PrototypeLocationAccuracy,
  grant: PrototypeLocationGrant,
  available: Collection<String> = ALL_PROVIDERS,
  enabled: Collection<String> = available,
): String? {
  val preferred =
    when {
      sdk >= 31 ->
        listOf(
          FUSED_PROVIDER,
          LocationManager.GPS_PROVIDER,
          LocationManager.NETWORK_PROVIDER,
        )
      accuracy == PrototypeLocationAccuracy.APPROXIMATE ||
        grant != PrototypeLocationGrant.PRECISE ->
        listOf(LocationManager.NETWORK_PROVIDER, LocationManager.GPS_PROVIDER)
      else -> listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
    }
  // AOSP images have no network provider; the platform fuzzes a coarse-only grant on GPS itself.
  // A disabled provider never delivers (network-only mode on API 24-27 disables GPS): skip it.
  return preferred.firstOrNull { it in available && it in enabled }
}

private val ALL_PROVIDERS =
  listOf(
    FUSED_PROVIDER,
    LocationManager.GPS_PROVIDER,
    LocationManager.NETWORK_PROVIDER,
  )

// LocationManager.FUSED_PROVIDER, which only API 31 declares; used only where it is selected.
private const val FUSED_PROVIDER = "fused"
