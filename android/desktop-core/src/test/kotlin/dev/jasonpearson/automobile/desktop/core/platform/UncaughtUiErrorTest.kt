package dev.jasonpearson.automobile.desktop.core.platform

import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertFalse

class UncaughtUiErrorTest {

  @Test
  fun `a rebuilt-jar class-load failure gets the restart hint, not a raw class path`() {
    val message =
      uncaughtUiErrorMessage(
        NoClassDefFoundError(
          "dev/jasonpearson/automobile/desktop/core/daemon/DaemonPidReadResult\$Absent"
        )
      )

    assertContains(message, "NoClassDefFoundError")
    assertContains(message, "Restart AutoMobile")
    assertContains(message, "rebuild while the app was running")
  }

  @Test
  fun `an ordinary exception points at the application log`() {
    val message = uncaughtUiErrorMessage(IllegalStateException("boom"))

    assertContains(message, "IllegalStateException: boom")
    assertContains(message, "application log")
    assertFalse(message.contains("Restart AutoMobile"))
  }

  @Test
  fun `a message-less throwable still reads as a sentence`() {
    val message = uncaughtUiErrorMessage(RuntimeException())

    assertContains(message, "RuntimeException: no further detail")
  }
}
