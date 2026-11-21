package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import dev.jasonpearson.automobile.protocol.PrototypeRequestResponse
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class SavedPrototypeImageNetworkTest {
  private val context = ApplicationProvider.getApplicationContext<Context>()

  @After
  fun reset() {
    SavedPrototypeActivityDependencies.reset()
  }

  @Test
  fun `saved images cannot bypass an injected client without image support`() {
    SavedPrototypeActivityDependencies.httpClients = {
      PrototypeHttpClients.forSavedPrototype { error("No request expected") }
    }
    val device = SavedPrototypeActivityDependencies.network(context).device
    assertNull((device as PrototypeRemoteImageProvider).remoteImages)
  }

  @Test
  fun `saved images use the injected client image provider`() = runBlocking {
    val urls = mutableListOf<String>()
    val images = PrototypeRemoteImageLoader { url, _ ->
      urls += url
      PrototypeImageState.Missing
    }
    val device =
      object : PrototypeHttpClient, PrototypeRemoteImageProvider {
        override val remoteImages = images

        override suspend fun execute(request: PrototypeHttpRequest): PrototypeRequestResponse =
          error("No request expected")
      }
    SavedPrototypeActivityDependencies.httpClients = {
      PrototypeHttpClients.forSavedPrototype(device)
    }
    val adapted =
      SavedPrototypeActivityDependencies.network(context).device as PrototypeRemoteImageProvider
    adapted.remoteImages!!.load("https://images.example/i", PrototypeImageTarget(1, 1))
    assertEquals(listOf("https://images.example/i"), urls)
  }
}
