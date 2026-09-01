package dev.jasonpearson.automobile.desktop.core.workspace.picker

import dev.jasonpearson.automobile.desktop.core.daemon.DaemonBootstrapState
import dev.jasonpearson.automobile.desktop.core.daemon.DaemonLifecyclePhase
import kotlin.test.Test
import kotlin.test.assertEquals

class DevicePickerBootstrapMessageTest {

  @Test
  fun `narrates the slow bootstrap phases behind the loading state`() {
    assertEquals(
      "Installing the Bun runtime (one-time setup)…",
      loadingMessage(DaemonBootstrapState.Working(DaemonLifecyclePhase.InstallingRuntime)),
    )
    assertEquals(
      "Starting AutoMobile 0.0.67…",
      loadingMessage(
        DaemonBootstrapState.Working(
          DaemonLifecyclePhase.LaunchingDaemon(action = "start", version = "0.0.67")
        )
      ),
    )
    assertEquals(
      "Updating the AutoMobile daemon to 0.0.67…",
      loadingMessage(
        DaemonBootstrapState.Working(
          DaemonLifecyclePhase.LaunchingDaemon(action = "restart", version = "0.0.67")
        )
      ),
    )
    assertEquals(
      "Waiting for the AutoMobile daemon…",
      loadingMessage(DaemonBootstrapState.Working(DaemonLifecyclePhase.Verifying)),
    )
  }

  @Test
  fun `fast or inapplicable states keep the plain device loading message`() {
    assertEquals("Loading devices…", loadingMessage(DaemonBootstrapState.Inactive))
    assertEquals("Loading devices…", loadingMessage(DaemonBootstrapState.Unknown))
    assertEquals("Loading devices…", loadingMessage(DaemonBootstrapState.Ready(restarted = false)))
    assertEquals(
      "Loading devices…",
      loadingMessage(DaemonBootstrapState.Working(DaemonLifecyclePhase.Probing)),
    )
  }
}
