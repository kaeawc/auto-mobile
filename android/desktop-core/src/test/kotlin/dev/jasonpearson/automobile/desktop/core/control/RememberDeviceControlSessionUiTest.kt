package dev.jasonpearson.automobile.desktop.core.control

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.runComposeUiTest
import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.daemon.DesktopInputAllocation
import dev.jasonpearson.automobile.desktop.core.testing.FakeAutoMobileClient
import dev.jasonpearson.automobile.desktop.domain.DevicePoint
import dev.jasonpearson.automobile.desktop.domain.PostInputRefreshState
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel

/**
 * Pins the composition wiring that makes the IDE's device controls active tool use (#10975): a tap
 * issued through the host's [rememberDeviceControlSession] allocates its device to the desktop
 * session before the daemon sees it. The unit tests of `inputAllocatingClient` cannot catch a call
 * site that hands the session the raw provider; this does.
 */
@OptIn(ExperimentalTestApi::class)
class RememberDeviceControlSessionUiTest {

  private class RecordingAllocation(private val allowed: Boolean = true) : DesktopInputAllocation {
    val requested = mutableListOf<String>()

    override fun awaitInputAllowed(deviceId: String): Boolean {
      requested += deviceId
      return allowed
    }
  }

  private val point = DevicePoint(x = 360, y = 780, inBounds = true)

  @Test
  fun `a tap allocates its device to the desktop session before the daemon sees it`() =
    runComposeUiTest {
      val scope = CoroutineScope(Dispatchers.Unconfined)
      val allocation = RecordingAllocation()
      val client = FakeAutoMobileClient()
      lateinit var session: DeviceControlSession
      setContent {
        session =
          rememberDeviceControlSession(
            scope = scope,
            clientProvider = { client },
            inputAllocation = { allocation },
            platform = { "android" },
            nowMs = { 1_000L },
            publishError = {},
            streamingEnabled = false,
            uiContext = Dispatchers.Unconfined,
            ioDispatcher = Dispatchers.Unconfined,
          )
      }

      assertTrue(session.tap(testSnapshot(deviceId = "emulator-5554"), point))
      waitForIdle()

      assertEquals(listOf("emulator-5554"), allocation.requested)
      assertEquals("emulator-5554", client.inputTapCalls.single().deviceId)
      scope.cancel()
    }

  @Test
  fun `a refused allocation keeps the tap from the daemon and shows the error`() =
    runComposeUiTest {
      val scope = CoroutineScope(Dispatchers.Unconfined)
      val allocation = RecordingAllocation(allowed = false)
      val client = FakeAutoMobileClient()
      val errors = mutableListOf<String?>()
      lateinit var session: DeviceControlSession
      setContent {
        session =
          rememberDeviceControlSession(
            scope = scope,
            clientProvider = { client },
            inputAllocation = { allocation },
            platform = { "android" },
            nowMs = { 1_000L },
            publishError = { errors += it },
            streamingEnabled = false,
            uiContext = Dispatchers.Unconfined,
            ioDispatcher = Dispatchers.Unconfined,
          )
      }

      session.tap(testSnapshot(deviceId = "emulator-5554"), point)
      waitForIdle()

      assertEquals(listOf("emulator-5554"), allocation.requested)
      assertTrue(client.inputTapCalls.isEmpty(), "an unallocated device must not be tapped")
      assertTrue(errors.any { it != null }, "the dropped input is reported (got $errors)")
      scope.cancel()
    }

  @Test
  fun `a swapped provider and allocation take effect behind the one session`() = runComposeUiTest {
    val scope = CoroutineScope(Dispatchers.Unconfined)
    val first = FakeAutoMobileClient()
    val second = FakeAutoMobileClient()
    val firstAllocation = RecordingAllocation()
    val secondAllocation = RecordingAllocation()
    val provider = mutableStateOf<() -> AutoMobileClient>({ first })
    val allocation = mutableStateOf<DesktopInputAllocation>(firstAllocation)
    lateinit var session: DeviceControlSession
    setContent {
      val currentProvider = provider.value
      val currentAllocation = allocation.value
      session =
        rememberDeviceControlSession(
          scope = scope,
          clientProvider = currentProvider,
          inputAllocation = { currentAllocation },
          platform = { "android" },
          nowMs = { 1_000L },
          publishError = {},
          streamingEnabled = false,
          uiContext = Dispatchers.Unconfined,
          ioDispatcher = Dispatchers.Unconfined,
        )
    }
    val held = session

    provider.value = { second }
    allocation.value = secondAllocation
    waitForIdle()
    held.tap(testSnapshot(deviceId = "emulator-5554"), point)
    waitForIdle()

    assertTrue(first.inputTapCalls.isEmpty() && firstAllocation.requested.isEmpty())
    assertEquals(listOf("emulator-5554"), secondAllocation.requested)
    assertEquals(1, second.inputTapCalls.size)
    scope.cancel()
  }

  @Test
  fun `swapping the provider resets what the previous one left pending`() = runComposeUiTest {
    val scope = CoroutineScope(Dispatchers.Unconfined)
    val provider = mutableStateOf<() -> AutoMobileClient>({ FakeAutoMobileClient() })
    lateinit var session: DeviceControlSession
    setContent {
      session =
        rememberDeviceControlSession(
          scope = scope,
          clientProvider = provider.value,
          inputAllocation = { RecordingAllocation() },
          platform = { "android" },
          nowMs = { 1_000L },
          publishError = {},
          streamingEnabled = false,
          uiContext = Dispatchers.Unconfined,
          ioDispatcher = Dispatchers.Unconfined,
        )
    }
    session.tap(testSnapshot(), point)
    waitForIdle()
    assertTrue(session.refreshState != PostInputRefreshState.Idle, "the tap awaits a refresh")

    provider.value = { FakeAutoMobileClient() }
    waitForIdle()

    assertEquals(PostInputRefreshState.Idle, session.refreshState)
    scope.cancel()
  }

  @Test
  fun `the host builds its control session only through rememberDeviceControlSession`() {
    // The composition tests above pin the helper; this pins that the host uses it, so a host that
    // constructs the session itself with a raw provider cannot slip past them (#10975).
    val host =
      java.io
        .File("src/main/kotlin/dev/jasonpearson/automobile/desktop/core/AutoMobileContent.kt")
        .readText()
    assertTrue("rememberDeviceControlSession(" in host, "the host must use the shared wiring")
    assertTrue("DeviceControlSession(" !in host.replace("rememberDeviceControlSession(", ""))
  }
}
