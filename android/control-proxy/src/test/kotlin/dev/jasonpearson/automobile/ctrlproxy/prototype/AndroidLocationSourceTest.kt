package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.content.ContextWrapper
import org.junit.Assert.assertEquals
import org.junit.Test

class AndroidLocationSourceTest {
  @Test
  fun `construction and unused close need neither a context nor Main`() {
    val source = AndroidLocationSource(ContextWrapper(null))
    PrototypeLocationModule(source).close()
  }

  @Test
  fun `platform fused on 31 and later and gps or network on older releases`() {
    for (sdk in listOf(26, 28, 30, 31, 36)) {
      for (accuracy in PrototypeLocationAccuracy.entries) {
        for (grant in PrototypeLocationGrant.entries) {
          val expected =
            when {
              sdk >= 31 -> "fused"
              accuracy == PrototypeLocationAccuracy.PRECISE &&
                grant == PrototypeLocationGrant.PRECISE -> "gps"
              else -> "network"
            }
          assertEquals(expected, locationProvider(sdk, accuracy, grant))
        }
      }
    }
  }

  @Test
  fun `falls back to gps when the image has no network provider`() {
    val available = listOf("gps", "passive")
    assertEquals(
      "gps",
      locationProvider(
        30,
        PrototypeLocationAccuracy.APPROXIMATE,
        PrototypeLocationGrant.APPROXIMATE,
        available,
      ),
    )
    assertEquals(
      "gps",
      locationProvider(
        34,
        PrototypeLocationAccuracy.PRECISE,
        PrototypeLocationGrant.PRECISE,
        available,
      ),
    )
  }

  @Test
  fun `selects only enabled providers and nothing when none is enabled`() {
    val available = listOf("gps", "network", "passive")
    // Network-only mode on API 24-27 disables GPS; a precise request must use network.
    assertEquals(
      "network",
      locationProvider(
        26,
        PrototypeLocationAccuracy.PRECISE,
        PrototypeLocationGrant.PRECISE,
        available,
        listOf("network", "passive"),
      ),
    )
    assertEquals(
      null,
      locationProvider(
        26,
        PrototypeLocationAccuracy.PRECISE,
        PrototypeLocationGrant.PRECISE,
        available,
        listOf("passive"),
      ),
    )
  }
}
