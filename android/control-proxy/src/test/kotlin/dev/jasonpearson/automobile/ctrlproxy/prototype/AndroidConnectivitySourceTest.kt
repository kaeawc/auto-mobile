package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import androidx.test.core.app.ApplicationProvider
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowNetwork
import org.robolectric.shadows.ShadowNetworkCapabilities

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AndroidConnectivitySourceTest {
  private val context = ApplicationProvider.getApplicationContext<Context>()
  private val manager = context.getSystemService(ConnectivityManager::class.java)

  @Test
  fun `onAvailable alone fills the state, as API 24 and 25 deliver it`() {
    val source = AndroidConnectivitySource(context)
    source.state
    val network = ShadowNetwork.newInstance(7)
    val capabilities = ShadowNetworkCapabilities.newInstance()
    shadowOf(capabilities).addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
    shadowOf(capabilities).addCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
    shadowOf(capabilities).addCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
    shadowOf(manager).setNetworkCapabilities(network, capabilities)
    shadowOf(manager).networkCallbacks.forEach { it.onAvailable(network) }
    assertEquals(JsonPrimitive(true), source.state.value["online"])
    assertEquals(JsonPrimitive("wifi"), source.state.value["transport"])
    source.close()
  }

  @Test
  fun `the first state read already holds the current network, so the first callback is no change`() {
    val capabilities = ShadowNetworkCapabilities.newInstance()
    shadowOf(capabilities).addTransportType(NetworkCapabilities.TRANSPORT_CELLULAR)
    shadowOf(capabilities).addCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
    shadowOf(manager).setNetworkCapabilities(manager.activeNetwork, capabilities)
    val source = AndroidConnectivitySource(context)
    val first = source.state.value
    assertEquals(JsonPrimitive(true), first["online"])
    assertEquals(JsonPrimitive("cellular"), first["transport"])
    shadowOf(manager).networkCallbacks.forEach { it.onAvailable(manager.activeNetwork!!) }
    assertEquals(first, source.state.value)
    source.close()
  }

  @Test
  fun `callbacks register on the first state read and close unregisters them`() {
    val source = AndroidConnectivitySource(context)
    assertTrue(shadowOf(manager).networkCallbacks.isEmpty())
    source.state
    assertEquals(1, shadowOf(manager).networkCallbacks.size)
    source.close()
    assertTrue(shadowOf(manager).networkCallbacks.isEmpty())
  }
}
