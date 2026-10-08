package dev.jasonpearson.automobile.desktop.core.workspace

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

class InteractionNotifyingControlExecutorTest {
  @Test
  fun buttonPressReportsUserInteractionBeforeDelegating() = runTest {
    val events = mutableListOf<String>()
    val delegate =
      object : EmulatorControlExecutor by NoOpEmulatorControlExecutor {
        override suspend fun pressButton(
          deviceId: String,
          platform: Platform,
          button: DeviceButton,
        ) {
          events += "press:$deviceId:${button.toolValue}"
        }
      }
    val executor = InteractionNotifyingControlExecutor(delegate) { events += "interaction:$it" }

    executor.pressButton("emulator-5554", Platform.Android, DeviceButton.Home)

    assertEquals(listOf("interaction:emulator-5554", "press:emulator-5554:home"), events)
  }

  @Test
  fun otherControlsDoNotReportInteraction() = runTest {
    val fake = FakeEmulatorControlExecutor()
    val interactions = mutableListOf<String>()
    val executor = InteractionNotifyingControlExecutor(fake) { interactions += it }

    executor.setLocale("emulator-5554", Platform.Android, "fr-FR")

    assertEquals(emptyList<String>(), interactions)
    assertEquals(1, fake.localeRequests.size)
  }
}
