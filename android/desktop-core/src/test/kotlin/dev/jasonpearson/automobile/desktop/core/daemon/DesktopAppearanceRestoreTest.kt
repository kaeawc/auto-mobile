package dev.jasonpearson.automobile.desktop.core.daemon

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.runComposeUiTest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The daemon keeps an appearance choice per session and drops it when the session is released for
 * good (#10976), so every desktop session rotation lost the user's choice and the new session read
 * the global default (#11363). The desktop remembers the choice and re-sends it with
 * `set_appearance` under each session once it registers.
 */
@OptIn(ExperimentalTestApi::class)
internal class DesktopAppearanceRestoreTest : DesktopDaemonSessionCompositionFixture() {
  private val dark = AppearanceSyncMode.Dark

  @Test
  fun `the choice is re-sent under the session after an idle release and after a device switch`() =
    runComposeUiTest {
      val transport = RecordingDaemonTransport()
      val host = start(transport, listOf(pixel))
      // The dashboard's client: it records each choice the user makes.
      val dashboard =
        RememberingAppearanceClient(
          appearanceStore.clientFor { host.state().sessionUuidProvider() },
          appearanceChoices,
        )
      tick()
      assertTrue(input(host, pixel.deviceId))
      tick()
      dashboard.setMode(dark)
      assertEquals(
        listOf<Pair<String?, AppearanceSyncMode>>("session-1" to dark),
        appearanceStore.modesSet,
      )

      // The daemon idle-releases session-1, and its appearance row goes with it.
      transport.releasedSessions += "session-1"
      appearanceStore.configs.remove("session-1")
      tick()
      settle()
      tick()

      assertEquals("session-2", host.state().sessionUuidProvider())
      assertEquals(dark.wireName, appearanceStore.configFor("session-2").defaultMode)
      assertEquals(dark.wireName, dashboard.getConfig().config.defaultMode)

      // A device switch: session-2 takes the device on input, then its pane gives way to another
      // device, which rotates the session and releases session-2 for good.
      assertTrue(input(host, pixel.deviceId))
      tick()
      host.panes.value = listOf(pixelFold)
      settle()
      appearanceStore.configs.remove("session-2")
      repeat(2) { tick() }

      assertEquals("session-3", host.state().sessionUuidProvider())
      assertEquals(dark.wireName, appearanceStore.configFor("session-3").defaultMode)
      assertEquals(
        listOf<Pair<String?, AppearanceSyncMode>>(
          "session-1" to dark,
          "session-2" to dark,
          "session-3" to dark,
        ),
        appearanceStore.modesSet,
      )
      assertEquals(2, host.state().appearanceRestores)
    }

  @Test
  fun `a rotation with no remembered choice sends nothing`() = runComposeUiTest {
    val transport = RecordingDaemonTransport()
    val host = start(transport, listOf(pixel))
    tick()
    assertTrue(input(host, pixel.deviceId))
    tick()

    transport.releasedSessions += "session-1"
    tick()
    settle()
    tick()

    assertEquals("session-2", host.state().sessionUuidProvider())
    assertEquals(emptyList(), appearanceStore.modesSet)
    assertEquals(0, host.state().appearanceRestores)
  }

  @Test
  fun `a failed restore is logged, not counted, and the session keeps watching`() =
    runComposeUiTest {
      val transport = RecordingDaemonTransport()
      val host = start(transport, listOf(pixel))
      val dashboard =
        RememberingAppearanceClient(
          appearanceStore.clientFor { host.state().sessionUuidProvider() },
          appearanceChoices,
        )
      tick()
      assertTrue(input(host, pixel.deviceId))
      tick()
      dashboard.setMode(dark)

      appearanceStore.failNextSet = true
      transport.releasedSessions += "session-1"
      tick()
      settle()
      repeat(2) { tick() }

      assertEquals("session-2", host.state().sessionUuidProvider())
      assertEquals(true, host.state().isRegistered)
      assertEquals(0, host.state().appearanceRestores)
      assertEquals(null, appearanceStore.configs["session-2"])
    }

  @Test
  fun `the memory keeps the mode a successful call left the config at`() {
    val memory = AppearanceChoiceMemory()

    memory.remember(AppearanceConfig(syncWithHost = false, defaultMode = "light"))
    assertEquals(AppearanceSyncMode.Light, memory.lastChoice)
    memory.remember(AppearanceConfig(syncWithHost = true, defaultMode = "auto"))
    assertEquals(AppearanceSyncMode.Auto, memory.lastChoice)
    // Host sync off with an `auto` default is no mode `set_appearance` sends: nothing to restore.
    memory.remember(AppearanceConfig(syncWithHost = false, defaultMode = "auto"))
    assertEquals(null, memory.lastChoice)
  }
}

/**
 * The daemon's per-session appearance rows (#10976): each session reads its own row, or the global
 * default when it stored none, and [modesSet] records every `set_appearance` in order.
 */
internal class SessionAppearanceStore {
  val configs = ConcurrentHashMap<String, AppearanceConfig>()
  val modesSet = CopyOnWriteArrayList<Pair<String?, AppearanceSyncMode>>()

  /** When true, the next `set_appearance` fails like an unreachable socket. */
  @Volatile var failNextSet = false

  fun configFor(sessionUuid: String?): AppearanceConfig =
    sessionUuid?.let { configs[it] } ?: GLOBAL_DEFAULT

  fun clientFor(sessionUuidProvider: () -> String?): AppearanceClient =
    object : AppearanceClient {
      override fun getConfig(): AppearanceResult =
        AppearanceResult(configFor(sessionUuidProvider()))

      override fun setSyncWithHost(enabled: Boolean): AppearanceResult =
        update(sessionUuidProvider()) { it.copy(syncWithHost = enabled) }

      override fun setMode(mode: AppearanceSyncMode): AppearanceResult {
        if (failNextSet) {
          failNextSet = false
          throw McpConnectionException("Appearance socket not found")
        }
        val sessionUuid = sessionUuidProvider()
        modesSet += sessionUuid to mode
        // Mirrors the daemon's coupling of mode and host sync.
        return update(sessionUuid) {
          it.copy(defaultMode = mode.wireName, syncWithHost = mode == AppearanceSyncMode.Auto)
        }
      }

      override fun isAvailable(): Boolean = true
    }

  private fun update(
    sessionUuid: String?,
    change: (AppearanceConfig) -> AppearanceConfig,
  ): AppearanceResult {
    val next = change(configFor(sessionUuid))
    sessionUuid?.let { configs[it] = next }
    return AppearanceResult(next)
  }

  private companion object {
    /** The daemon's defaults (`ServerConfig.getAppearanceDefaults`). */
    val GLOBAL_DEFAULT =
      AppearanceConfig(syncWithHost = true, defaultMode = "auto", applyOnConnect = true)
  }
}
