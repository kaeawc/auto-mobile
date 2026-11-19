package dev.jasonpearson.automobile.ctrlproxy.prototype

import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.test.*
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class AndroidBiometricSourceTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun warm() = runTest {
      val gateway = Gateway().apply { status = 11 }
      val source = AndroidBiometricSource(gateway, StandardTestDispatcher(testScheduler))
      source.authenticate(PrototypeBiometricRequest("Warm")).single()
      source.close()
    }
  }

  private class Gateway : AndroidBiometricGateway {
    override var sdk = 30
    override var foreground = true
    var status = 0
    var checked: Boolean? = null
    var shown: PrototypeBiometricRequest? = null
    var deliver: ((PrototypeBiometricOutcome) -> Unit)? = null
    var cancellations = 0

    override fun canAuthenticate(credential: Boolean): Int {
      checked = credential
      return status
    }

    override fun show(
      request: PrototypeBiometricRequest,
      deliver: (PrototypeBiometricOutcome) -> Unit,
    ): () -> Unit {
      shown = request
      this.deliver = deliver
      return { cancellations++ }
    }
  }

  private val request = PrototypeBiometricRequest("Unlock", "Confirm", true)

  @Test
  fun `every framework code maps without retaining error text`() {
    assertNull(biometricError(0))
    val cases =
      mapOf(
        PrototypeBiometricOutcome.CANCELLED to listOf(5, 10),
        PrototypeBiometricOutcome.NOT_ENROLLED to listOf(11, 14),
        PrototypeBiometricOutcome.NO_HARDWARE to listOf(1, 12),
        PrototypeBiometricOutcome.LOCKOUT to listOf(7, 9),
        PrototypeBiometricOutcome.ERROR to listOf(2, 3, 4, 8, 15, 999),
      )
    cases.forEach { (outcome, codes) ->
      codes.forEach { assertEquals(outcome, biometricError(it)) }
    }
  }

  @Test
  fun `preflight refusals never show a prompt`() = runTest {
    val gateway = Gateway()
    val source = AndroidBiometricSource(gateway, StandardTestDispatcher(testScheduler))
    for ((code, expected) in
      listOf(
        11 to PrototypeBiometricOutcome.NOT_ENROLLED,
        12 to PrototypeBiometricOutcome.NO_HARDWARE,
        1 to PrototypeBiometricOutcome.NO_HARDWARE,
        7 to PrototypeBiometricOutcome.LOCKOUT,
        9 to PrototypeBiometricOutcome.LOCKOUT,
        99 to PrototypeBiometricOutcome.ERROR,
      )) {
      gateway.status = code
      assertEquals(expected, source.authenticate(request).single())
      assertNull(gateway.shown)
    }
    assertEquals(true, gateway.checked)
    source.close()
  }

  @Test
  fun `API 28 without fingerprint hardware refuses before showing a prompt`() = runTest {
    val gateway =
      Gateway().apply {
        sdk = 28
        status = 12
      }
    val source = AndroidBiometricSource(gateway, StandardTestDispatcher(testScheduler))
    assertEquals(
      PrototypeBiometricOutcome.NO_HARDWARE,
      source.authenticate(request.copy(allowDeviceCredential = false)).single(),
    )
    assertEquals(false, gateway.checked)
    assertNull(gateway.shown)
    source.close()
  }

  @Test
  fun `API 28 with fingerprint hardware lets the prompt report enrollment and lockout errors`() =
    runTest {
      for ((code, outcome) in
        listOf(
          11 to PrototypeBiometricOutcome.NOT_ENROLLED,
          7 to PrototypeBiometricOutcome.LOCKOUT,
          9 to PrototypeBiometricOutcome.LOCKOUT,
          1 to PrototypeBiometricOutcome.NO_HARDWARE,
          12 to PrototypeBiometricOutcome.NO_HARDWARE,
        )) {
        val gateway = Gateway().apply { sdk = 28 }
        val source = AndroidBiometricSource(gateway, StandardTestDispatcher(testScheduler))
        val biometricRequest = request.copy(allowDeviceCredential = false)
        val pending = async { source.authenticate(biometricRequest).single() }
        runCurrent()
        assertEquals(false, gateway.checked)
        assertEquals(biometricRequest, gateway.shown)
        assertFalse(pending.isCompleted)
        gateway.deliver!!(biometricError(code)!!)
        assertEquals(outcome, pending.await())
        assertEquals(1, gateway.cancellations)
        source.close()
      }
    }

  @Test
  fun `API and foreground gates run before framework access`() = runTest {
    for ((sdk, credential) in listOf(27 to false, 28 to true)) {
      val gateway = Gateway().apply { this.sdk = sdk }
      val source = AndroidBiometricSource(gateway, StandardTestDispatcher(testScheduler))
      assertEquals(
        PrototypeBiometricOutcome.NO_HARDWARE,
        source.authenticate(request.copy(allowDeviceCredential = credential)).single(),
      )
      assertNull(gateway.checked)
      assertNull(gateway.shown)
      source.close()
    }
    val gateway = Gateway().apply { foreground = false }
    val source = AndroidBiometricSource(gateway, StandardTestDispatcher(testScheduler))
    assertEquals(PrototypeBiometricOutcome.UNAVAILABLE, source.authenticate(request).single())
    assertNull(gateway.checked)
  }

  @Test
  fun `failed attempts keep prompt active and terminal completion cancels exactly once`() =
    runTest {
      for (sdk in listOf(28, 29, 30, 36)) {
        val gateway = Gateway().apply { this.sdk = sdk }
        val source = AndroidBiometricSource(gateway, StandardTestDispatcher(testScheduler))
        val request = request.copy(allowDeviceCredential = sdk >= 29)
        val outcomes = mutableListOf<PrototypeBiometricOutcome>()
        val job = launch { source.authenticate(request).toList(outcomes) }
        runCurrent()
        assertEquals(request, gateway.shown)
        gateway.deliver!!(PrototypeBiometricOutcome.ATTEMPT_FAILED)
        runCurrent()
        assertFalse(job.isCompleted)
        assertEquals(0, gateway.cancellations)
        gateway.deliver!!(PrototypeBiometricOutcome.SUCCESS)
        job.join()
        assertEquals(
          listOf(PrototypeBiometricOutcome.ATTEMPT_FAILED, PrototypeBiometricOutcome.SUCCESS),
          outcomes,
        )
        assertEquals(1, gateway.cancellations)
        source.close()
        assertEquals(1, gateway.cancellations)
      }
    }

  @Test
  fun `teardown caller cancellation and competing prompt release ownership`() = runTest {
    val gateway = Gateway()
    val source = AndroidBiometricSource(gateway, StandardTestDispatcher(testScheduler))
    val pending = async { source.authenticate(request).toList() }
    runCurrent()
    assertEquals(PrototypeBiometricOutcome.BUSY, source.authenticate(request).single())
    pending.cancelAndJoin()
    assertEquals(1, gateway.cancellations)
    val second = async { source.authenticate(request).toList() }
    runCurrent()
    source.close()
    assertEquals(listOf(PrototypeBiometricOutcome.CANCELLED), second.await())
    assertEquals(2, gateway.cancellations)
    gateway.deliver!!(PrototypeBiometricOutcome.SUCCESS)
    assertEquals(PrototypeBiometricOutcome.UNAVAILABLE, source.authenticate(request).single())
    source.close()
    assertEquals(2, gateway.cancellations)
  }
}
