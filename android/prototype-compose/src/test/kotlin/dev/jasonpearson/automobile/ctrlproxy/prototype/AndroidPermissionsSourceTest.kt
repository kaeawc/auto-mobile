package dev.jasonpearson.automobile.ctrlproxy.prototype

import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.test.*
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class AndroidPermissionsSourceTest {
  private class Store : PrototypePermissionRequestStore {
    override var asked = false
  }

  private class Gateway : AndroidPermissionsGateway {
    override var sdk = 33
    override var foreground = true
    override var granted = false
    override var notificationsEnabled = true
    override var rationale = false
    override val resumes = MutableSharedFlow<Unit>()
    var deliver: (() -> Unit)? = null
    var registrations = 0
    var unregistrations = 0

    override fun request(deliver: () -> Unit): () -> Unit {
      registrations++
      this.deliver = deliver
      return { unregistrations++ }
    }
  }

  companion object {
    @BeforeClass
    @JvmStatic
    fun warm() = runTest {
      val gateway = Gateway()
      val source = AndroidPermissionsSource(gateway, Store(), StandardTestDispatcher(testScheduler))
      val pending = async { source.request().single() }
      runCurrent()
      gateway.granted = true
      gateway.deliver!!()
      pending.await()
      source.close()
    }
  }

  @Test
  fun `API 33 status distinguishes initial denial rationale permanent denial and disabled notifications`() =
    runTest {
      val gateway = Gateway()
      val store = Store()
      val source = AndroidPermissionsSource(gateway, store, StandardTestDispatcher(testScheduler))
      assertEquals(PrototypePermissionState.NOT_DETERMINED, source.status())
      store.asked = true
      gateway.rationale = true
      assertEquals(PrototypePermissionState.DENIED, source.status())
      gateway.rationale = false
      assertEquals(PrototypePermissionState.BLOCKED, source.status())
      gateway.granted = true
      assertEquals(PrototypePermissionState.GRANTED, source.status())
      gateway.notificationsEnabled = false
      assertEquals(PrototypePermissionState.BLOCKED, source.status())
      gateway.foreground = false
      assertEquals(PrototypePermissionState.UNAVAILABLE, source.status())
      source.close()
      gateway.foreground = true
      assertEquals(PrototypePermissionState.UNAVAILABLE, source.status())
    }

  @Test
  fun `API before 33 follows app notification setting and never prompts`() = runTest {
    for (enabled in listOf(true, false)) {
      val gateway =
        Gateway().apply {
          sdk = 32
          notificationsEnabled = enabled
        }
      val store = Store()
      val source = AndroidPermissionsSource(gateway, store, StandardTestDispatcher(testScheduler))
      val expected =
        if (enabled) PrototypePermissionState.GRANTED else PrototypePermissionState.BLOCKED
      assertEquals(expected, source.status())
      assertEquals(PrototypePermissionOutcome.Status(expected), source.request().single())
      assertEquals(0, gateway.registrations)
      assertFalse(store.asked)
      source.close()
    }
  }

  @Test
  fun `granted blocked and background requests never register a launcher`() = runTest {
    for (expected in
      listOf(
        PrototypePermissionState.GRANTED,
        PrototypePermissionState.BLOCKED,
        PrototypePermissionState.UNAVAILABLE,
      )) {
      val gateway =
        Gateway().apply {
          granted = expected == PrototypePermissionState.GRANTED
          foreground = expected != PrototypePermissionState.UNAVAILABLE
        }
      val source =
        AndroidPermissionsSource(
          gateway,
          Store().apply { asked = true },
          StandardTestDispatcher(testScheduler),
        )
      assertEquals(PrototypePermissionOutcome.Status(expected), source.request().single())
      assertEquals(0, gateway.registrations)
      source.close()
    }
  }

  @Test
  fun `prompt records asked and re-reads the grant before resume then unregisters`() = runTest {
    for (expected in
      listOf(
        PrototypePermissionState.GRANTED,
        PrototypePermissionState.DENIED,
        PrototypePermissionState.BLOCKED,
      )) {
      val gateway = Gateway()
      val store = Store()
      val source = AndroidPermissionsSource(gateway, store, StandardTestDispatcher(testScheduler))
      val pending = async { source.request().single() }
      runCurrent()
      assertTrue(store.asked)
      assertEquals(1, gateway.registrations)
      assertFalse(pending.isCompleted)
      gateway.foreground = false
      gateway.granted = expected == PrototypePermissionState.GRANTED
      gateway.rationale = expected == PrototypePermissionState.DENIED
      gateway.deliver!!()
      assertEquals(PrototypePermissionOutcome.Status(expected), pending.await())
      assertEquals(1, gateway.unregistrations)
      source.close()
      assertEquals(1, gateway.unregistrations)
    }
  }

  @Test
  fun `deny twice becomes blocked and a third request does not prompt`() = runTest {
    val gateway = Gateway()
    val source = AndroidPermissionsSource(gateway, Store(), StandardTestDispatcher(testScheduler))
    for (rationale in listOf(true, false)) {
      val pending = async { source.request().single() }
      runCurrent()
      gateway.rationale = rationale
      gateway.deliver!!()
      assertEquals(
        PrototypePermissionOutcome.Status(
          if (rationale) PrototypePermissionState.DENIED else PrototypePermissionState.BLOCKED,
        ),
        pending.await(),
      )
    }
    assertEquals(
      PrototypePermissionOutcome.Status(PrototypePermissionState.BLOCKED),
      source.request().single(),
    )
    assertEquals(2, gateway.registrations)
    assertEquals(2, gateway.unregistrations)
    source.close()
  }

  @Test
  fun `competing requests cancellation and close release the permission-result registration`() =
    runTest {
      val gateway = Gateway()
      val store = Store()
      val source = AndroidPermissionsSource(gateway, store, StandardTestDispatcher(testScheduler))
      val pending = async { source.request().single() }
      runCurrent()
      assertEquals(PrototypePermissionOutcome.Busy, source.request().single())
      pending.cancelAndJoin()
      assertEquals(1, gateway.unregistrations)
      gateway.rationale = true
      val next = async { source.request().single() }
      runCurrent()
      source.close()
      assertEquals(PrototypePermissionOutcome.Cancelled, next.await())
      assertEquals(2, gateway.unregistrations)
      gateway.deliver!!()
      assertEquals(
        PrototypePermissionOutcome.Status(PrototypePermissionState.UNAVAILABLE),
        source.request().single(),
      )
      source.close()
      assertEquals(2, gateway.unregistrations)
    }

  @Test
  fun `resume re-reads authorization and collector cancellation removes observer`() = runTest {
    val gateway = Gateway()
    val source = AndroidPermissionsSource(gateway, Store(), StandardTestDispatcher(testScheduler))
    val changes = mutableListOf<PrototypePermissionState>()
    val job = launch { source.changes.toList(changes) }
    runCurrent()
    assertEquals(1, gateway.resumes.subscriptionCount.value)
    gateway.granted = true
    gateway.resumes.emit(Unit)
    runCurrent()
    gateway.notificationsEnabled = false
    gateway.resumes.emit(Unit)
    runCurrent()
    assertEquals(
      listOf(PrototypePermissionState.GRANTED, PrototypePermissionState.BLOCKED),
      changes,
    )
    job.cancelAndJoin()
    assertEquals(0, gateway.resumes.subscriptionCount.value)
    source.close()
  }
}
