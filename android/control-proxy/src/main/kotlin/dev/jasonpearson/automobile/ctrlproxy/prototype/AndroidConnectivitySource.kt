package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.util.Log
import androidx.core.content.ContextCompat
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.json.JsonObject

/**
 * Default-network connectivity for prototype `/platform/connectivity` (#14273). Needs only the
 * normal ACCESS_NETWORK_STATE permission, so the overlay can read it without a prompt. Callbacks
 * register on the first state read, so an idle overlay holds none and the context is touched
 * lazily.
 */
internal class AndroidConnectivitySource(private val context: Context) :
  PrototypeConnectivitySource {
  private val manager by lazy { context.getSystemService(ConnectivityManager::class.java) }
  private val tracker = ConnectivityTracker()
  override val state: StateFlow<JsonObject>
    get() {
      start()
      return tracker.state
    }

  private val callback =
    object : ConnectivityManager.NetworkCallback() {
      // API 24 and 25 announce the current default network with onAvailable alone, without a
      // following onCapabilitiesChanged, so read its capabilities here too.
      override fun onAvailable(network: Network) {
        manager.getNetworkCapabilities(network)?.let { tracker.onNetwork(reading(it)) }
      }

      override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
        tracker.onNetwork(reading(capabilities))
      }

      override fun onLost(network: Network) {
        tracker.onNetwork(null)
      }
    }

  private val dataSaverReceiver =
    object : BroadcastReceiver() {
      override fun onReceive(context: Context, intent: Intent) {
        tracker.onDataSaver(dataSaverOn())
      }
    }

  private var started = false
  private var networkRegistered = false
  private var receiverRegistered = false

  @Synchronized
  private fun start() {
    if (started) return
    started = true
    try {
      tracker.onDataSaver(dataSaverOn())
      // Seed the current network before registering, so the callback's first delivery of the same
      // network is not a transition and does not fire connectivity.changed at startup.
      manager.activeNetwork?.let(manager::getNetworkCapabilities)?.let {
        tracker.onNetwork(reading(it))
      }
      manager.registerDefaultNetworkCallback(callback)
      networkRegistered = true
      ContextCompat.registerReceiver(
        context,
        dataSaverReceiver,
        IntentFilter(ConnectivityManager.ACTION_RESTRICT_BACKGROUND_CHANGED),
        ContextCompat.RECEIVER_NOT_EXPORTED,
      )
      receiverRegistered = true
    } catch (@Suppress("TooGenericExceptionCaught") error: RuntimeException) {
      // A missing permission or too many callbacks leaves the state offline; prototypes still run.
      Log.w(TAG, "Connectivity callback registration failed", error)
    }
  }

  private fun dataSaverOn(): Boolean =
    manager.restrictBackgroundStatus != ConnectivityManager.RESTRICT_BACKGROUND_STATUS_DISABLED

  @Synchronized
  override fun close() {
    try {
      if (networkRegistered) manager.unregisterNetworkCallback(callback)
      if (receiverRegistered) context.unregisterReceiver(dataSaverReceiver)
    } catch (error: IllegalArgumentException) {
      // Already unregistered by the platform: nothing is left to release.
      Log.w(TAG, "Connectivity callback was not registered", error)
    } finally {
      networkRegistered = false
      receiverRegistered = false
    }
  }

  private companion object {
    const val TAG = "PrototypeConnectivity"

    private val transports =
      listOf(
        NetworkCapabilities.TRANSPORT_VPN to ConnectivityTransport.VPN,
        NetworkCapabilities.TRANSPORT_WIFI to ConnectivityTransport.WIFI,
        NetworkCapabilities.TRANSPORT_CELLULAR to ConnectivityTransport.CELLULAR,
        NetworkCapabilities.TRANSPORT_ETHERNET to ConnectivityTransport.ETHERNET,
      )

    fun reading(capabilities: NetworkCapabilities) =
      ConnectivityNetwork(
        validated = capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED),
        notMetered = capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED),
        transports =
          transports.filter { capabilities.hasTransport(it.first) }.map { it.second }.toSet(),
      )
  }
}
