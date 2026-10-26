package dev.jasonpearson.automobile.protoviewer

import androidx.test.core.app.ApplicationProvider
import java.io.File
import java.io.IOException
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class OpenSourceLicensesTest {
  private val generated: LicenseDocument by lazy {
    val context = ApplicationProvider.getApplicationContext<ProtoViewerApplication>()
    checkNotNull(loadLicenseDocument { context.resources.openRawResource(R.raw.aboutlibraries) })
  }

  @Test
  fun everyBundledRuntimeDependencyHasALicenseEntryWithFullText() {
    assertTrue(generated.libraries.size > 20)
    assertEquals(emptyList<String>(), generated.librariesMissingLicense())
    val ids = generated.libraries.map { it.uniqueId }.toSet()
    assertTrue(ids.containsAll(setOf("com.squareup.okhttp3:okhttp", "androidx.core:core")))
    assertTrue("androidx.compose.material3:material3" in ids)
  }

  @Test
  fun apacheLicenseTextIsTheRepositoryLicenseWithoutItsCopyrightNotice() {
    // The repository LICENSE fills in the appendix with AutoMobile's own copyright holders; the
    // text shown for third-party libraries must keep the unfilled template.
    val repositoryLicense = File("../../LICENSE").readText()
    val template =
      repositoryLicense.replace(
        "   Copyright 2025 Zillow, Inc.\n   Copyright 2025-2026 Jason Pearson\n",
        "   Copyright [yyyy] [name of copyright owner]\n",
      )
    assertNotEquals(repositoryLicense, template)
    val shown = checkNotNull(generated.licenses.getValue("Apache-2.0").content)
    assertEquals(template, shown)
    assertFalse(shown.contains("Zillow"))
  }

  @Test
  fun everyLibraryNamesItsOwner() {
    val unowned = generated.libraries.filter { it.owner == null }.map { it.uniqueId }
    assertEquals(emptyList<String>(), unowned)
  }

  @Test
  fun flagsLibrariesWithoutLicenseOrText() {
    val document =
      parseLicenseDocument(
        """{"libraries":[
          {"uniqueId":"a:ok","licenses":["MIT"]},
          {"uniqueId":"a:none","licenses":[]},
          {"uniqueId":"a:unknown","licenses":["GPL"]},
          {"uniqueId":"a:blank","licenses":["EMPTY"]}],
          "licenses":{"MIT":{"content":"text"},"EMPTY":{"content":" "}},"extra":1}""",
      )
    assertEquals(listOf("a:none", "a:unknown", "a:blank"), document.librariesMissingLicense())
  }

  @Test
  fun unreadableOrMalformedSourcesReturnNull() {
    assertNull(loadLicenseDocument { throw IOException("boom") })
    assertNull(loadLicenseDocument { "not json".byteInputStream() })
    assertEquals(
      emptyList<LicensedLibrary>(),
      loadLicenseDocument { "{}".byteInputStream() }?.libraries,
    )
  }

  @Test
  fun displayNameFallsBackToUniqueId() {
    assertEquals("a:b", LicensedLibrary("a:b").displayName)
    assertEquals("A B", LicensedLibrary("a:b", name = "A B").displayName)
    assertEquals("a:b", LicensedLibrary("a:b", name = " ").displayName)
  }
}
