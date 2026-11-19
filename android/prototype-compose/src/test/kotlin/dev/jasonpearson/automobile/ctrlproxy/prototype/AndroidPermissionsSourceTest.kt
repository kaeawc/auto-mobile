package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import dev.jasonpearson.automobile.prototype.PlatformCall
import dev.jasonpearson.automobile.prototype.PrototypePlatform as RuntimePlatform
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.test.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class AndroidPermissionsSourceTest {
  private class Store : PrototypePermissionRequestStore {
    override var rationaleSeen = false
  }

  private class Gateway : AndroidPermissionsGateway {
    override var permission = PrototypeRuntimePermission.NOTIFICATIONS
    override var declared = true
    override var hardware = true
    override var settling = false
    override var sdk = 33
    override var foreground = true
    override var granted = false
    override var notificationsEnabled = true
    override var rationale = false
    override val resumes = MutableSharedFlow<Unit>()
    var deliver: ((Boolean) -> Unit)? = null
    var cancel: (() -> Unit)? = null
    var launch: ((Boolean) -> Unit) -> Unit = {}
    var active = false
    var registrations = 0
    var unregistrations = 0

    override fun request(deliver: (Boolean) -> Unit, cancel: () -> Unit): (() -> Unit)? {
      if (active) return null
      launch(deliver)
      registrations++
      active = true
      this.deliver = deliver
      this.cancel = cancel
      return {
        if (active) {
          active = false
          unregistrations++
        }
      }
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
      gateway.deliver!!(gateway.granted)
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
      assertFalse(store.rationaleSeen)
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
          Store().apply { rationaleSeen = true },
          StandardTestDispatcher(testScheduler),
        )
      assertEquals(PrototypePermissionOutcome.Status(expected), source.request().single())
      assertEquals(0, gateway.registrations)
      source.close()
    }
  }

  @Test
  fun `prompt re-reads grant and rationale before resume then unregisters`() = runTest {
    for (expected in
      listOf(
        PrototypePermissionState.GRANTED,
        PrototypePermissionState.DENIED,
        PrototypePermissionState.BLOCKED,
      )) {
      val gateway = Gateway()
      val store = Store().apply { rationaleSeen = expected == PrototypePermissionState.BLOCKED }
      if (store.rationaleSeen) gateway.rationale = true
      val source = AndroidPermissionsSource(gateway, store, StandardTestDispatcher(testScheduler))
      val pending = async { source.request().single() }
      runCurrent()
      assertEquals(expected == PrototypePermissionState.BLOCKED, store.rationaleSeen)
      assertEquals(1, gateway.registrations)
      assertFalse(pending.isCompleted)
      gateway.foreground = false
      gateway.granted = expected == PrototypePermissionState.GRANTED
      gateway.rationale = expected == PrototypePermissionState.DENIED
      gateway.deliver!!(gateway.granted)
      assertEquals(PrototypePermissionOutcome.Status(expected), pending.await())
      assertEquals(expected != PrototypePermissionState.GRANTED, store.rationaleSeen)
      assertEquals(1, gateway.unregistrations)
      source.close()
      assertEquals(1, gateway.unregistrations)
    }
  }

  @Test
  fun `dismissed prompt remains undetermined and a second request registers a launcher`() =
    runTest {
      val gateway = Gateway()
      val store = Store()
      val source = AndroidPermissionsSource(gateway, store, StandardTestDispatcher(testScheduler))
      repeat(2) { attempt ->
        val pending = async { source.request().single() }
        runCurrent()
        assertEquals(attempt + 1, gateway.registrations)
        gateway.deliver!!(false)
        assertEquals(
          PrototypePermissionOutcome.Status(PrototypePermissionState.NOT_DETERMINED),
          pending.await(),
        )
        assertEquals(PrototypePermissionState.NOT_DETERMINED, source.status())
        assertFalse(store.rationaleSeen)
        assertEquals(attempt + 1, gateway.unregistrations)
      }
      source.close()
    }

  @Test
  fun `deny twice becomes blocked and a third request does not prompt`() = runTest {
    val gateway = Gateway()
    val source = AndroidPermissionsSource(gateway, Store(), StandardTestDispatcher(testScheduler))
    for (rationale in listOf(true, false)) {
      val pending = async { source.request().single() }
      runCurrent()
      gateway.rationale = rationale
      gateway.deliver!!(gateway.granted)
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
      gateway.deliver!!(gateway.granted)
      assertEquals(
        PrototypePermissionOutcome.Status(PrototypePermissionState.UNAVAILABLE),
        source.request().single(),
      )
      source.close()
      assertEquals(2, gateway.unregistrations)
    }

  @Test
  fun `prototype sessions isolate denial history while sharing one Activity prompt`() = runTest {
    val gateway = Gateway()
    val parent = AndroidPermissionsSource(gateway, Store(), StandardTestDispatcher(testScheduler))
    val first = parent.session()
    val second = parent.session()
    val pending = async { first.request().single() }
    runCurrent()
    assertEquals(PrototypePermissionOutcome.Busy, second.request().single())
    gateway.rationale = true
    gateway.deliver!!(false)
    assertEquals(
      PrototypePermissionOutcome.Status(PrototypePermissionState.DENIED),
      pending.await(),
    )
    gateway.rationale = false
    assertEquals(PrototypePermissionState.BLOCKED, first.status())
    assertEquals(PrototypePermissionState.NOT_DETERMINED, second.status())
    assertEquals(PrototypePermissionState.NOT_DETERMINED, parent.status())
    first.close()
    second.close()
    parent.close()
  }

  @Test
  fun `teardown clears denial history and a reset session starts undetermined`() = runTest {
    val gateway = Gateway()
    val store = Store()
    val source = AndroidPermissionsSource(gateway, store, StandardTestDispatcher(testScheduler))
    val pending = async { source.request().single() }
    runCurrent()
    gateway.rationale = true
    gateway.deliver!!(false)
    assertEquals(
      PrototypePermissionOutcome.Status(PrototypePermissionState.DENIED),
      pending.await(),
    )
    assertTrue(store.rationaleSeen)
    source.close()
    assertFalse(store.rationaleSeen)
    gateway.rationale = false
    val reset = source.session()
    assertEquals(PrototypePermissionState.NOT_DETERMINED, reset.status())
    reset.close()
  }

  @Test
  fun `runtime teardown clears denied session and reset reuses Activity with fresh history`() =
    runTest {
      val gateway = Gateway()
      val source = AndroidPermissionsSource(gateway, Store(), StandardTestDispatcher(testScheduler))
      val platform = RuntimePlatform(listOf(PrototypePermissionsModule(source, backgroundScope)))
      val spec =
        PrototypeSpec(
          "notifications",
          PrototypeWindow(PrototypeFullscreenPlacement()),
          root = PrototypeTextNode(text = "Permission"),
          requires = PrototypeRequires(platform = listOf("permissions")),
        )
      fun runtime() =
        PrototypeRuntime(
            spec,
            sink = {},
            nextSequence = { 1L },
            warn = { error(it) },
            requestScope = backgroundScope,
            platform = platform,
            clock = { testScheduler.currentTime },
            monotonicMs = { testScheduler.currentTime },
          )
          .also { it.startPlatformModules() }
      val first = runtime()
      val module =
        first.platformRegistry.modules.filterIsInstance<PrototypePermissionsModule>().single()
      val pending = async {
        module.call(
          PlatformCall(
            "ask",
            "permissions.request",
            buildJsonObject {
              put("names", JsonArray(listOf(JsonPrimitive("notifications"))))
            },
          ),
        )
      }
      runCurrent()
      gateway.rationale = true
      gateway.deliver!!(false)
      pending.await()
      assertEquals(JsonPrimitive("denied"), module.state.value["notifications"])
      gateway.rationale = false
      first.close()
      runCurrent()
      // The host reuses its module on reset; only the old runtime's session is closed.
      val reset = runtime()
      runCurrent()
      assertEquals(
        JsonPrimitive("notDetermined"),
        reset.current.platformState.getValue("permissions").jsonObject["notifications"],
      )
      assertEquals(PrototypePermissionState.NOT_DETERMINED, source.status())
      assertEquals(1, gateway.unregistrations)
      reset.close()
      platform.registry.modules.forEach { it.close() }
    }

  @Test
  fun `grant result followed by host revoke is undetermined`() = runTest {
    val gateway = Gateway()
    val store = Store()
    val source = AndroidPermissionsSource(gateway, store, StandardTestDispatcher(testScheduler))
    val pending = async { source.request().single() }
    runCurrent()
    gateway.granted = true
    gateway.deliver!!(true)
    assertEquals(
      PrototypePermissionOutcome.Status(PrototypePermissionState.GRANTED),
      pending.await(),
    )
    gateway.granted = false
    assertEquals(PrototypePermissionState.NOT_DETERMINED, source.status())
    assertFalse(store.rationaleSeen)
    source.close()
  }

  @Test
  fun `observed settings grant clears a previous denial before a host revoke`() = runTest {
    val gateway = Gateway()
    val store = Store().apply { rationaleSeen = true }
    val source = AndroidPermissionsSource(gateway, store, StandardTestDispatcher(testScheduler))
    assertEquals(PrototypePermissionState.BLOCKED, source.status())
    gateway.granted = true
    assertEquals(PrototypePermissionState.GRANTED, source.status())
    assertFalse(store.rationaleSeen)
    gateway.granted = false
    assertEquals(PrototypePermissionState.NOT_DETERMINED, source.status())
    source.close()
  }

  @Test
  fun `failed launch does not record a denial even with a synchronous callback`() = runTest {
    val gateway = Gateway()
    val store = Store()
    val failure = IllegalStateException("launch failed")
    gateway.launch = { deliver ->
      assertFalse(store.rationaleSeen)
      deliver(false)
      throw failure
    }
    val source = AndroidPermissionsSource(gateway, store, StandardTestDispatcher(testScheduler))
    val thrown = runCatching { source.request().single() }.exceptionOrNull()
    // Coroutine stack-trace recovery may copy the exception across flowOn.
    assertEquals(failure.javaClass, thrown?.javaClass)
    assertEquals(failure.message, thrown?.message)
    assertFalse(store.rationaleSeen)
    assertEquals(PrototypePermissionState.NOT_DETERMINED, source.status())
    source.close()
  }

  @Test
  fun `destroy cancellation drops a late result without recording denial or retaining registration`() =
    runTest {
      val gateway = Gateway()
      val store = Store()
      val source = AndroidPermissionsSource(gateway, store, StandardTestDispatcher(testScheduler))
      val pending = async { source.request().single() }
      runCurrent()
      val lateResult = gateway.deliver!!
      // Destruction must also win over a result queued for collection on the main dispatcher.
      lateResult(false)
      gateway.foreground = false
      gateway.cancel!!()
      assertEquals(PrototypePermissionOutcome.Cancelled, pending.await())
      assertEquals(1, gateway.unregistrations)
      lateResult(false)
      runCurrent()
      assertFalse(store.rationaleSeen)
      source.close()
      lateResult(false)
      assertFalse(store.rationaleSeen)
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

  @Test
  fun `camera and microphone prompt on every sdk and ignore the notification setting`() = runTest {
    for (kind in listOf(PrototypeRuntimePermission.CAMERA, PrototypeRuntimePermission.MICROPHONE)) {
      val gateway =
        Gateway().apply {
          permission = kind
          sdk = 26
          notificationsEnabled = false
        }
      val source = AndroidPermissionsSource(gateway, Store(), StandardTestDispatcher(testScheduler))
      assertEquals(PrototypePermissionState.NOT_DETERMINED, source.status())
      val pending = async { source.request().single() }
      runCurrent()
      assertEquals(1, gateway.registrations)
      gateway.granted = true
      gateway.deliver!!(true)
      assertEquals(
        PrototypePermissionOutcome.Status(PrototypePermissionState.GRANTED),
        pending.await(),
      )
      source.close()
    }
  }

  @Test
  fun `undeclared or absent capture hardware is unavailable and never prompts`() = runTest {
    for (missing in listOf("declared", "hardware")) {
      val gateway =
        Gateway().apply {
          permission = PrototypeRuntimePermission.CAMERA
          declared = missing != "declared"
          hardware = missing != "hardware"
        }
      val source = AndroidPermissionsSource(gateway, Store(), StandardTestDispatcher(testScheduler))
      assertEquals(PrototypePermissionState.UNAVAILABLE, source.status())
      assertEquals(
        PrototypePermissionOutcome.Status(PrototypePermissionState.UNAVAILABLE),
        source.request().single(),
      )
      assertEquals(0, gateway.registrations)
      source.close()
    }
  }

  @Test
  fun `capture is unavailable while the Activity is not resumed`() = runTest {
    val gateway =
      Gateway().apply {
        permission = PrototypeRuntimePermission.MICROPHONE
        granted = true
        foreground = false
      }
    val source = AndroidPermissionsSource(gateway, Store(), StandardTestDispatcher(testScheduler))
    assertEquals(PrototypePermissionState.UNAVAILABLE, source.status())
    gateway.foreground = true
    assertEquals(PrototypePermissionState.GRANTED, source.status())
    source.close()
  }

  @Test
  fun `a request right after a prompt waits for resume instead of reading unavailable`() = runTest {
    val gateway =
      Gateway().apply {
        permission = PrototypeRuntimePermission.MICROPHONE
        foreground = false
        settling = true
      }
    val source = AndroidPermissionsSource(gateway, Store(), StandardTestDispatcher(testScheduler))
    val pending = async { source.request().single() }
    runCurrent()
    assertEquals(0, gateway.registrations)
    gateway.foreground = true
    gateway.settling = false
    gateway.resumes.emit(Unit)
    runCurrent()
    assertEquals(1, gateway.registrations)
    gateway.granted = true
    gateway.deliver!!(true)
    assertEquals(
      PrototypePermissionOutcome.Status(PrototypePermissionState.GRANTED),
      pending.await(),
    )
    source.close()
  }

  @Test
  fun `closing while waiting for resume cancels without prompting`() = runTest {
    val gateway =
      Gateway().apply {
        permission = PrototypeRuntimePermission.CAMERA
        foreground = false
        settling = true
      }
    val source = AndroidPermissionsSource(gateway, Store(), StandardTestDispatcher(testScheduler))
    val pending = async { source.request().single() }
    runCurrent()
    source.close()
    assertEquals(PrototypePermissionOutcome.Cancelled, pending.await())
    assertEquals(0, gateway.registrations)
  }
}
