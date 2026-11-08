package dev.jasonpearson.automobile.ctrlproxy

import io.mockk.mockk
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DeviceInfoControllerTest {
  private val controller =
    DeviceInfoController(
      context = mockk(),
      serviceInfo = { null },
      displayController = DisplayController(mockk(relaxed = true)),
      asyncActionRunner = mockk(),
      broadcast = {},
    )

  @Test
  fun `permission dialog root cannot pair with the playground event activity`() {
    assertNull(
      controller.getForegroundActivity(
        rootPackage = "com.google.android.permissioncontroller",
        windowClass = "dev.jasonpearson.automobile.playground.MainActivity",
        windowPackage = "dev.jasonpearson.automobile.playground",
      ),
    )
  }

  @Test
  fun `same package retains the short activity component`() {
    assertEquals(
      "dev.jasonpearson.automobile.playground/.MainActivity",
      controller.getForegroundActivity(
        rootPackage = "dev.jasonpearson.automobile.playground",
        windowClass = "dev.jasonpearson.automobile.playground.MainActivity",
        windowPackage = "dev.jasonpearson.automobile.playground",
      ),
    )
  }

  @Test
  fun `unknown event package retains the old pairing behavior`() {
    assertEquals(
      "com.google.android.permissioncontroller/dev.jasonpearson.automobile.playground.MainActivity",
      controller.getForegroundActivity(
        rootPackage = "com.google.android.permissioncontroller",
        windowClass = "dev.jasonpearson.automobile.playground.MainActivity",
        windowPackage = null,
      ),
    )
  }
}
