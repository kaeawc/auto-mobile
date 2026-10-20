package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Test

class PrototypeRefreshTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun warmMapping() {
      PrototypeSpecValidator.validate("{}")
    }
  }

  private val refresh =
    PrototypeScrollRefresh(
      stateKey = "busy",
      onRefresh = listOf(PrototypeEmitAction("reload")),
    )

  private fun spec(refreshing: Boolean, node: PrototypeScrollNode) =
    PrototypeSpec(
      id = "panel",
      window = PrototypeWindow(PrototypeFullscreenPlacement()),
      state = mapOf("busy" to PrototypeScalar.BooleanValue(refreshing)),
      root = node,
    )

  @Test
  fun `a pull sets the key first and then runs the authored actions in order`() {
    assertEquals(
      listOf(
        PrototypeSetStateAction("busy", PrototypeScalar.BooleanValue(true)),
        PrototypeEmitAction("reload"),
      ),
      prototypeRefreshActions(refresh),
    )
  }

  @Test
  fun `the scroll node shows the indicator exactly while the key is true`() {
    val node = PrototypeScrollNode(refresh = refresh, child = PrototypeTextNode(text = "x"))
    assertTrue(mapPrototypeSpec(spec(true, node)).root.checked)
    assertFalse(mapPrototypeSpec(spec(false, node)).root.checked)
    val plain = PrototypeScrollNode(child = PrototypeTextNode(text = "x"))
    assertFalse(mapPrototypeSpec(spec(true, plain)).root.checked)
  }
}
