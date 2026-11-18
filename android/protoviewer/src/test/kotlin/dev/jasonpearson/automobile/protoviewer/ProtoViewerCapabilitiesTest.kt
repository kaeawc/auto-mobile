package dev.jasonpearson.automobile.protoviewer

import dev.jasonpearson.automobile.ctrlproxy.prototype.SavedPrototypeSaveRequest
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidation
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidator
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Test

class ProtoViewerCapabilitiesTest {
  companion object {
    private lateinit var locationSpec: String
    private lateinit var biometricSpec: String
    private lateinit var permissionsSpec: String

    @JvmStatic
    @BeforeClass
    fun loadFixture() {
      locationSpec =
        generateSequence(File(System.getProperty("user.dir") ?: ".").absoluteFile) { it.parentFile }
          .map { File(it, "test/fixtures/prototype-spec/valid/location-block-minimal.json") }
          .first { it.isFile }
          .readText()
      biometricSpec =
        generateSequence(File(System.getProperty("user.dir") ?: ".").absoluteFile) { it.parentFile }
          .map { File(it, "test/fixtures/prototype-spec/valid/platform-biometric.json") }
          .first { it.isFile }
          .readText()
      permissionsSpec =
        generateSequence(File(System.getProperty("user.dir") ?: ".").absoluteFile) { it.parentFile }
          .map { File(it, "test/fixtures/prototype-spec/valid/platform-permissions-request.json") }
          .first { it.isFile }
          .readText()
      Fixtures.spec
    }
  }

  @Test
  fun reportedCapabilitiesAcceptPermissionsWithoutAdvertisingNotifications() {
    val capabilities = protoViewerMcpAbout(42, "test").capabilities
    assertTrue("prototype_platform_permissions_v1" in capabilities)
    assertTrue("prototype_platform_notifications_v1" !in capabilities)
    assertTrue(
      PrototypeSpecValidator.validate(permissionsSpec, capabilities, library = true)
        is PrototypeSpecValidation.Success,
    )
  }

  @Test
  fun reportedCapabilitiesAcceptLocationSpecAndLibraryRequirements() {
    val capabilities = protoViewerMcpAbout(42, "test").capabilities
    assertTrue(
      PrototypeSpecValidator.validate(locationSpec, capabilities, library = true)
        is PrototypeSpecValidation.Success,
    )
    val repository =
      DirectoryLibraryRepository(
        FakeSavedStore(),
        FakeLibraryFiles(),
        LibraryStorage(FakePrototypeStorage()),
        IdGenerator { FIRST },
        LibraryClock { 42 },
      )
    val request =
      SavedPrototypeSaveRequest("location-block-minimal", "Nearby", locationSpec, emptyList())
    val added = repository.add(request, LibrarySource.mcp, listOf("prototype_platform_location_v1"))
    assertTrue(added.toString(), added is LibraryResult.Success)
    val loaded = repository.get(FIRST)
    assertTrue(loaded.toString(), loaded is LibraryResult.Success)
  }

  @Test
  fun reportedCapabilitiesAcceptBiometricSpec() {
    val capabilities = protoViewerMcpAbout(42, "test").capabilities
    assertTrue("prototype_platform_biometric_v1" in capabilities)
    assertTrue(
      PrototypeSpecValidator.validate(biometricSpec, capabilities, library = true)
        is PrototypeSpecValidation.Success,
    )
  }

  @Test
  fun reportedCapabilitiesIncludeRegisteredLocationModule() {
    val about = protoViewerMcpAbout(42, "test")
    assertEquals(42L, about.versionCode)
    assertEquals("test", about.versionName)
    assertTrue("prototype_platform_location_v1" in about.capabilities)
  }
}
