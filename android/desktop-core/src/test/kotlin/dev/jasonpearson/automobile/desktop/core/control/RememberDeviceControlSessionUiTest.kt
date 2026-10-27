package dev.jasonpearson.automobile.desktop.core.control

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.runComposeUiTest
import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.daemon.DesktopDaemonSessionState
import dev.jasonpearson.automobile.desktop.core.daemon.DesktopInputAllocation
import dev.jasonpearson.automobile.desktop.core.testing.FakeAutoMobileClient
import dev.jasonpearson.automobile.desktop.domain.DevicePoint
import dev.jasonpearson.automobile.desktop.domain.PostInputRefreshState
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertSame
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
internal class RememberDeviceControlSessionUiTest :
  RememberDeviceControlSessionUiDispatcherFixture() {

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
      val scope = CoroutineScope(testDispatcher)
      val allocation = RecordingAllocation()
      val client = FakeAutoMobileClient()
      lateinit var session: DeviceControlSession
      setContent {
        session =
          rememberDeviceControlSession(
            DesktopDaemonSessionState(
              session = null,
              boundDeviceId = null,
              inputAllocation = allocation,
            ),
            dev.jasonpearson.automobile.desktop.core.control.RememberDeviceControlOptions(
              scope = scope,
              clientProvider = { client },
              platform = { "android" },
              nowMs = { 1_000L },
              publishError = {},
              streamingEnabled = false,
              uiContext = testDispatcher,
              ioDispatcher = testDispatcher,
            ),
          )
      }

      assertTrue(session.tap(testSnapshot(TestSnapshotSpec(deviceId = "emulator-5554")), point))
      waitForIdle()

      assertEquals(listOf("emulator-5554"), allocation.requested)
      assertEquals("emulator-5554", client.inputTapCalls.single().deviceId)
      scope.cancel()
    }

  @Test
  fun `a refused allocation keeps the tap from the daemon and shows the error`() =
    runComposeUiTest {
      val scope = CoroutineScope(testDispatcher)
      val allocation = RecordingAllocation(allowed = false)
      val client = FakeAutoMobileClient()
      val errors = mutableListOf<String?>()
      lateinit var session: DeviceControlSession
      setContent {
        session =
          rememberDeviceControlSession(
            DesktopDaemonSessionState(
              session = null,
              boundDeviceId = null,
              inputAllocation = allocation,
            ),
            dev.jasonpearson.automobile.desktop.core.control.RememberDeviceControlOptions(
              scope = scope,
              clientProvider = { client },
              platform = { "android" },
              nowMs = { 1_000L },
              publishError = { errors += it },
              streamingEnabled = false,
              uiContext = testDispatcher,
              ioDispatcher = testDispatcher,
            ),
          )
      }

      session.tap(testSnapshot(TestSnapshotSpec(deviceId = "emulator-5554")), point)
      waitForIdle()

      assertEquals(listOf("emulator-5554"), allocation.requested)
      assertTrue(client.inputTapCalls.isEmpty(), "an unallocated device must not be tapped")
      assertTrue(errors.any { it != null }, "the dropped input is reported (got $errors)")
      scope.cancel()
    }

  @Test
  fun `a swapped provider and allocation take effect behind the one session`() = runComposeUiTest {
    val scope = CoroutineScope(testDispatcher)
    val first = FakeAutoMobileClient()
    val second = FakeAutoMobileClient()
    val firstAllocation = RecordingAllocation()
    val secondAllocation = RecordingAllocation()
    val provider = mutableStateOf<() -> AutoMobileClient>({ first })
    val desktopSessionState =
      mutableStateOf(
        DesktopDaemonSessionState(
          session = null,
          boundDeviceId = null,
          inputAllocation = firstAllocation,
        ),
      )
    lateinit var session: DeviceControlSession
    setContent {
      val currentProvider = provider.value
      session =
        rememberDeviceControlSession(
          desktopSessionState.value,
          dev.jasonpearson.automobile.desktop.core.control.RememberDeviceControlOptions(
            scope = scope,
            clientProvider = currentProvider,
            platform = { "android" },
            nowMs = { 1_000L },
            publishError = {},
            streamingEnabled = false,
            uiContext = testDispatcher,
            ioDispatcher = testDispatcher,
          ),
        )
    }
    val held = session

    provider.value = { second }
    desktopSessionState.value = desktopSessionState.value.copy(inputAllocation = secondAllocation)
    waitForIdle()
    held.tap(testSnapshot(TestSnapshotSpec(deviceId = "emulator-5554")), point)
    waitForIdle()

    assertTrue(first.inputTapCalls.isEmpty() && firstAllocation.requested.isEmpty())
    assertEquals(listOf("emulator-5554"), secondAllocation.requested)
    assertEquals(1, second.inputTapCalls.size)
    scope.cancel()
  }

  @Test
  fun `a swapped allocation takes effect without replacing the provider or session`() =
    runComposeUiTest {
      val scope = CoroutineScope(testDispatcher)
      val client = FakeAutoMobileClient()
      val provider: () -> AutoMobileClient = { client }
      val firstAllocation = RecordingAllocation()
      val secondAllocation = RecordingAllocation(allowed = false)
      val desktopSessionState =
        mutableStateOf(
          DesktopDaemonSessionState(
            session = null,
            boundDeviceId = null,
            inputAllocation = firstAllocation,
          ),
        )
      lateinit var session: DeviceControlSession
      setContent {
        session =
          rememberDeviceControlSession(
            desktopSessionState.value,
            dev.jasonpearson.automobile.desktop.core.control.RememberDeviceControlOptions(
              scope = scope,
              clientProvider = provider,
              platform = { "android" },
              nowMs = { 1_000L },
              publishError = {},
              streamingEnabled = false,
              uiContext = testDispatcher,
              ioDispatcher = testDispatcher,
            ),
          )
      }
      val held = session

      desktopSessionState.value = desktopSessionState.value.copy(inputAllocation = secondAllocation)
      waitForIdle()
      assertSame(held, session)
      held.tap(testSnapshot(TestSnapshotSpec(deviceId = "emulator-5554")), point)
      waitForIdle()

      assertTrue(firstAllocation.requested.isEmpty())
      assertEquals(listOf("emulator-5554"), secondAllocation.requested)
      assertTrue(client.inputTapCalls.isEmpty(), "the replacement allocation refuses the tap")
      scope.cancel()
    }

  @Test
  fun `swapping the provider resets what the previous one left pending`() = runComposeUiTest {
    val scope = CoroutineScope(testDispatcher)
    val provider = mutableStateOf<() -> AutoMobileClient>({ FakeAutoMobileClient() })
    val allocation = RecordingAllocation()
    lateinit var session: DeviceControlSession
    setContent {
      session =
        rememberDeviceControlSession(
          DesktopDaemonSessionState(
            session = null,
            boundDeviceId = null,
            inputAllocation = allocation,
          ),
          dev.jasonpearson.automobile.desktop.core.control.RememberDeviceControlOptions(
            scope = scope,
            clientProvider = provider.value,
            platform = { "android" },
            nowMs = { 1_000L },
            publishError = {},
            streamingEnabled = false,
            uiContext = testDispatcher,
            ioDispatcher = testDispatcher,
          ),
        )
    }
    session.tap(testSnapshot(TestSnapshotSpec()), point)
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
    val normalizedHost = host.replace(Regex("\\s+"), " ")
    assertTrue(
      "rememberDeviceControlSession( desktopSessionState," in normalizedHost,
      "the host must pass its desktop session state to the shared wiring",
    )
    val controlOptions =
      normalizedHost.substringAfter("RememberDeviceControlOptions(").substringBefore("),")
    assertTrue(
      !Regex("inputAllocation\\s*=\\s*\\{").containsMatchIn(controlOptions),
      "the host must not override the desktop session state's allocation through options",
    )
    assertTrue("DeviceControlSession(" !in host.replace("rememberDeviceControlSession(", ""))
  }
}

internal abstract class RememberDeviceControlSessionUiDispatcherFixture(
  protected val testDispatcher: kotlinx.coroutines.CoroutineDispatcher = Dispatchers.Unconfined,
)
