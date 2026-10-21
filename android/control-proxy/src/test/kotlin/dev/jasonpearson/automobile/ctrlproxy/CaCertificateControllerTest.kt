package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.perf.PerfProvider
import dev.jasonpearson.automobile.ctrlproxy.perf.TimeProvider
import dev.jasonpearson.automobile.protocol.ErrorResponse
import java.io.File
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

// The module already uses Robolectric for controllers that call Android Log, Build and Base64.
@RunWith(RobolectricTestRunner::class)
class CaCertificateControllerTest {
  @get:Rule val temporaryFolder = TemporaryFolder()

  @Test
  fun `install rejects a package that is not device owner before checking admin`() = runTest {
    val fixture = fixture()
    fixture.policy.deviceOwner = false

    fixture.controller.performInstallCaCertificate("request", BASE64)

    fixture.assertCertificateFrame(false, error = "Device owner is not active for $PACKAGE")
    assertEquals(listOf("owner:$PACKAGE"), fixture.policy.calls)
    assertFalse(File(fixture.directory, "ca_certs").exists())
  }

  @Test
  fun `install rejects an inactive admin with the existing text`() = runTest {
    val fixture = fixture()
    fixture.policy.adminActive = false

    fixture.controller.performInstallCaCertificate("request", BASE64)

    fixture.assertCertificateFrame(
      false,
      error = "Device admin receiver is not active for $PACKAGE",
    )
    assertEquals(listOf("owner:$PACKAGE", "admin"), fixture.policy.calls)
  }

  @Test
  fun `empty and invalid base64 fail before persistence or installation`() = runTest {
    for (payload in listOf("", " \n\t ", "a")) {
      val fixture = fixture()

      fixture.controller.performInstallCaCertificate("request", payload)

      fixture.assertCertificateFrame(false, error = "Certificate payload is empty or invalid")
      assertTrue(fixture.policy.installed.isEmpty())
      assertFalse(File(fixture.directory, "ca_certs").exists())
    }
  }

  @Test
  fun `base64 and PEM whitespace decode identically and use the deterministic SHA256 alias`() =
    runTest {
      for (payload in listOf(BASE64, " YW\nJj \t", PEM)) {
        val fixture = fixture()

        fixture.controller.performInstallCaCertificate("request", payload)

        fixture.assertCertificateFrame(true, alias = ALIAS, totalTimeMs = 7)
        assertArrayEquals(BYTES, fixture.policy.installed.single())
        assertArrayEquals(BYTES, File(fixture.directory, "ca_certs/$ALIAS.der").readBytes())
        assertEquals(
          listOf("owner:$PACKAGE", "admin", "install"),
          fixture.policy.calls,
        )
      }
    }

  @Test
  fun `stored certificate survives a new controller and removal reads then deletes it`() = runTest {
    val fixture = fixture()
    fixture.controller.performInstallCaCertificate("request", BASE64)
    fixture.sender.frames.clear()

    fixture.newController().performRemoveCaCertificate("request", ALIAS, null)

    fixture.assertCertificateFrame(true, action = "remove", alias = ALIAS, totalTimeMs = 11)
    assertArrayEquals(BYTES, fixture.policy.uninstalled.single())
    assertTrue(fixture.policy.installed.isEmpty())
    assertFalse(File(fixture.directory, "ca_certs/$ALIAS.der").exists())
  }

  @Test
  fun `failed installation broadcasts its alias and deletes the persisted certificate`() = runTest {
    val fixture = fixture()
    fixture.policy.installSuccess = false

    fixture.controller.performInstallCaCertificate("request", BASE64)

    fixture.assertCertificateFrame(
      false,
      alias = ALIAS,
      error = "DevicePolicyManager.installCaCert returned false",
      totalTimeMs = 7,
    )
    assertFalse(File(fixture.directory, "ca_certs/$ALIAS.der").exists())
  }

  @Test
  fun `persistence failure prevents installation`() = runTest {
    val fixture = fixture()
    File(fixture.directory, "ca_certs").writeText("not a directory")

    fixture.controller.performInstallCaCertificate("request", BASE64)

    fixture.assertCertificateFrame(
      false,
      alias = ALIAS,
      error = "Failed to persist certificate for alias: $ALIAS",
    )
    assertFalse(fixture.policy.calls.contains("install"))
  }

  @Test
  fun `path installs accept PEM base64 and binary payloads`() = runTest {
    val binary = byteArrayOf(0x30, 0x82.toByte(), 0x01, 0x00)
    for ((payload, expected) in
      listOf(PEM.toByteArray() to BYTES, " YW\nJj ".toByteArray() to BYTES, binary to binary)) {
      val fixture = fixture()
      val source = File(fixture.directory, "input.cert").apply { writeBytes(payload) }

      fixture.controller.performInstallCaCertificateFromPath("request", source.absolutePath)

      assertArrayEquals(expected, fixture.policy.installed.single())
      assertEquals(
        "true",
        fixture.sender.frames.single().content["success"]?.jsonPrimitive?.content,
      )
    }
  }

  @Test
  fun `missing empty and directory paths broadcast the original failure`() = runTest {
    val fixture = fixture()
    val missing = File(fixture.directory, "missing")
    val empty = File(fixture.directory, "empty").apply { writeBytes(byteArrayOf()) }
    for (source in listOf(missing, empty, fixture.directory)) {
      fixture.sender.frames.clear()

      fixture.controller.performInstallCaCertificateFromPath("request", source.absolutePath)

      fixture.assertCertificateFrame(
        false,
        error = "Certificate file is empty or unreadable: ${source.absolutePath}",
      )
    }
    assertTrue(fixture.policy.calls.isEmpty())
  }

  @Test
  fun `removal requires stored bytes or a certificate payload`() = runTest {
    val fixture = fixture()

    fixture.controller.performRemoveCaCertificate("request", null, null)
    fixture.assertCertificateFrame(
      false,
      action = "remove",
      error = "Certificate payload is required for removal",
    )
    fixture.sender.frames.clear()

    fixture.controller.performRemoveCaCertificate("request", ALIAS, null)
    fixture.assertCertificateFrame(
      false,
      action = "remove",
      alias = ALIAS,
      error = "No stored certificate found for alias: $ALIAS",
    )
  }

  @Test
  fun `removal falls back to supplied certificate when alias is not stored`() = runTest {
    val fixture = fixture()
    fixture.policy.installed += BYTES

    fixture.controller.performRemoveCaCertificate("request", ALIAS, BASE64)

    fixture.assertCertificateFrame(true, action = "remove", alias = ALIAS, totalTimeMs = 11)
    assertArrayEquals(BYTES, fixture.policy.uninstalled.single())
  }

  @Test
  fun `removal computes an alias and rejects certificates that are not installed`() = runTest {
    val fixture = fixture()

    fixture.controller.performRemoveCaCertificate("request", null, BASE64)

    fixture.assertCertificateFrame(
      false,
      action = "remove",
      alias = ALIAS,
      error = "CA certificate is not installed",
    )
    assertTrue(fixture.policy.uninstalled.isEmpty())
  }

  @Test
  fun `device owner status reports booleans even when device owner is false`() = runTest {
    val fixture = fixture()
    fixture.policy.deviceOwner = false

    fixture.controller.performGetDeviceOwnerStatus("request")

    assertEquals(
      Frame(
        "device_owner_status_result",
        "request",
        mapOf(
          "success" to "true",
          "totalTimeMs" to "0",
          "packageName" to PACKAGE,
          "isDeviceOwner" to "false",
          "isAdminActive" to "true",
        ),
      ),
      fixture.sender.frames.single().asFrame(),
    )
  }

  @Test
  fun `device owner status failure preserves partial state and error text`() = runTest {
    val fixture = fixture()
    fixture.policy.adminFailure = IllegalStateException("admin unavailable")

    fixture.controller.performGetDeviceOwnerStatus("request")

    assertEquals(
      Frame(
        "device_owner_status_result",
        "request",
        mapOf(
          "success" to "false",
          "totalTimeMs" to "0",
          "packageName" to PACKAGE,
          "isDeviceOwner" to "true",
          "isAdminActive" to "false",
          "error" to "Failed to read device owner status: admin unavailable",
        ),
      ),
      fixture.sender.frames.single().asFrame(),
    )
  }

  @Test
  fun `stopped server skips both result broadcasts`() = runTest {
    val fixture = fixture()
    fixture.sender.running = false

    fixture.controller.performInstallCaCertificate("request", BASE64)
    fixture.controller.performGetDeviceOwnerStatus("request")

    assertTrue(fixture.sender.frames.isEmpty())
    assertEquals(0, fixture.sender.connectionCountReads)
    assertTrue(fixture.errors.isEmpty())
    assertArrayEquals(BYTES, fixture.policy.installed.single())
  }

  @Test
  fun `sender failure still emits the correlated fallback via ResultBroadcaster`() = runTest {
    val fixture = fixture()
    fixture.sender.failure = IllegalStateException("send failed")

    fixture.controller.performInstallCaCertificate("request", BASE64)

    assertTrue(fixture.sender.frames.isEmpty())
    assertEquals("request", fixture.errors.single().requestId)
    assertEquals(
      "Broadcast failed for ca_cert_result: send failed",
      fixture.errors.single().error,
    )
  }

  @Test
  fun `cancellation propagates after the existing finally broadcast and cleanup`() = runTest {
    val fixture = fixture()
    val cancellation = CancellationException("cancel install")
    fixture.policy.installFailure = cancellation

    try {
      fixture.controller.performInstallCaCertificate("request", BASE64)
      fail("Cancellation must propagate")
    } catch (actual: CancellationException) {
      assertSame(cancellation, actual)
    }

    fixture.assertCertificateFrame(false, alias = ALIAS, totalTimeMs = 7)
    assertFalse(File(fixture.directory, "ca_certs/$ALIAS.der").exists())
    assertTrue(fixture.errors.isEmpty())
  }

  private fun fixture() = Fixture(temporaryFolder.newFolder())

  private class Fixture(val directory: File) {
    val timer = FakeTimer()
    val policy = FakeDevicePolicy(timer)
    private val perfProvider = PerfProvider.createForTesting(timer)
    val sender = CapturingTransport(perfProvider)
    val errors = mutableListOf<ErrorResponse>()
    val controller = newController()

    fun newController() =
      CaCertificateController(
        dependencies =
          CaCertificateDependencies(
            devicePolicy = policy,
            packageName = PACKAGE,
            filesDir = { directory },
          ),
        perfProvider = perfProvider,
        timeProvider = timer,
        resultSender =
          guardedResultSender(
            sender,
            ResultBroadcaster(broadcastError = { errors += it }, logError = { _, _ -> }),
          ),
      )

    fun assertCertificateFrame(
      success: Boolean,
      action: String = "install",
      alias: String? = null,
      error: String? = null,
      totalTimeMs: Long = 0,
    ) {
      val expected =
        mutableMapOf(
          "action" to action,
          "success" to success.toString(),
          "totalTimeMs" to totalTimeMs.toString(),
        )
      alias?.let { expected["alias"] = it }
      error?.let { expected["error"] = it }
      assertEquals(Frame("ca_cert_result", "request", expected), sender.frames.single().asFrame())
      assertTrue(errors.isEmpty())
    }
  }

  private class FakeTimer : TimeProvider {
    private var now = 1_000L

    override fun currentTimeMillis() = now

    fun advanceBy(durationMs: Long) {
      now += durationMs
    }
  }

  private class FakeDevicePolicy(private val timer: FakeTimer) :
    CaCertificateController.DevicePolicy {
    var deviceOwner = true
    var adminActive = true
    var adminFailure: Exception? = null
    var installSuccess = true
    var installFailure: Exception? = null
    val installed = mutableListOf<ByteArray>()
    val uninstalled = mutableListOf<ByteArray>()
    val calls = mutableListOf<String>()

    override fun isDeviceOwnerApp(packageName: String): Boolean {
      calls += "owner:$packageName"
      return deviceOwner
    }

    override fun isAdminActive(): Boolean {
      calls += "admin"
      adminFailure?.let { throw it }
      return adminActive
    }

    override fun installCaCert(certBytes: ByteArray): Boolean {
      calls += "install"
      timer.advanceBy(7)
      installFailure?.let { throw it }
      if (installSuccess) installed += certBytes
      return installSuccess
    }

    override fun uninstallCaCert(certBytes: ByteArray) {
      calls += "uninstall"
      timer.advanceBy(11)
      uninstalled += certBytes
      installed.removeAll { it.contentEquals(certBytes) }
    }

    override fun getInstalledCaCerts(): List<ByteArray> {
      calls += "installed"
      return installed.toList()
    }
  }

  private data class Frame(
    val type: String,
    val requestId: String?,
    val fields: Map<String, String>,
  )

  private data class CapturedFrame(
    val type: String,
    val requestId: String?,
    val content: JsonObject,
  ) {
    fun asFrame() = Frame(type, requestId, content.mapValues { it.value.jsonPrimitive.content })
  }

  private class CapturingTransport(private val perfProvider: PerfProvider) : FakeResultTransport() {
    var failure: Exception? = null
    var connectionCountReads = 0
    val frames = mutableListOf<CapturedFrame>()

    // Production flushes before building the frame; flush the real provider the same way.
    override fun flushPerfTiming(): JsonElement? {
      failure?.let { throw it }
      return perfProvider.flush()
    }

    override suspend fun sendFrame(frame: String) {
      assertTrue(running)
      val parsed = Json.parseToJsonElement(frame).jsonObject
      frames +=
        CapturedFrame(
          parsed.getValue("type").jsonPrimitive.content,
          parsed["requestId"]?.jsonPrimitive?.content,
          JsonObject(parsed - setOf("type", "timestamp", "requestId", "perfTiming")),
        )
    }

    override fun connectionCount(): Int {
      connectionCountReads++
      return 1
    }
  }

  private companion object {
    const val PACKAGE = "test.ctrlproxy"
    const val BASE64 = "YWJj"
    const val PEM = "-----BEGIN CERTIFICATE-----\nYW Jj\n-----END CERTIFICATE-----"
    const val ALIAS = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    val BYTES = "abc".toByteArray()
  }
}
