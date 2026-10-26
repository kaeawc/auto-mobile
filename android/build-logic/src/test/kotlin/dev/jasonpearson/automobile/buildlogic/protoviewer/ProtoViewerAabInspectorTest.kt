package dev.jasonpearson.automobile.buildlogic.protoviewer

import java.io.File
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class ProtoViewerAabInspectorTest {
  @get:Rule val tmp = TemporaryFolder()

  private val goodEntries =
    setOf(
      "BundleConfig.pb",
      "base/manifest/AndroidManifest.xml",
      "base/dex/classes.dex",
      ProtoViewerAabInspector.MAPPING_ENTRY,
    )

  private fun contents(
    entries: Set<String> = goodEntries,
    signers: List<String> = listOf("CN=ProtoViewer,O=AutoMobile"),
  ) = AabContents(entries, signers)

  @Test
  fun acceptsCompleteReleaseSignedBundle() {
    assertTrue(ProtoViewerAabInspector.violations(contents(), true, true).isEmpty())
  }

  @Test
  fun rejectsDebugSignedBundle() {
    val result =
      ProtoViewerAabInspector.violations(
        contents(signers = listOf("CN=Android Debug,O=Android,C=US")),
        true,
        true,
      )
    assertEquals(listOf("bundle is signed with the Android debug certificate"), result)
  }

  @Test
  fun rejectsUnsignedBundleWhenSignatureRequired() {
    val result = ProtoViewerAabInspector.violations(contents(signers = emptyList()), true, true)
    assertEquals(listOf("bundle is not signed"), result)
  }

  @Test
  fun allowsDebugSignatureWhenNotRequired() {
    val debug = contents(signers = listOf("CN=Android Debug"))
    assertTrue(ProtoViewerAabInspector.violations(debug, false, true).isEmpty())
  }

  @Test
  fun requiresMappingOnlyWhenMinified() {
    val noMapping = contents(entries = goodEntries - ProtoViewerAabInspector.MAPPING_ENTRY)
    assertTrue(
      ProtoViewerAabInspector.violations(noMapping, true, true).single().contains("R8 mapping"),
    )
    assertTrue(ProtoViewerAabInspector.violations(noMapping, true, false).isEmpty())
  }

  @Test
  fun reportsMissingStructuralEntries() {
    val result = ProtoViewerAabInspector.violations(contents(entries = emptySet()), true, false)
    assertEquals(3, result.size)
  }

  @Test
  fun readsEntryNamesFromAZipAndFindsNoSigners() {
    val bundle = File(tmp.root, "app.aab")
    ZipOutputStream(bundle.outputStream()).use { zip ->
      for (name in goodEntries) {
        zip.putNextEntry(ZipEntry(name))
        zip.write(byteArrayOf(1, 2, 3))
        zip.closeEntry()
      }
    }
    val read = ProtoViewerAabInspector.read(bundle)
    assertEquals(goodEntries, read.entryNames)
    assertTrue(read.signerSubjects.isEmpty())
    assertEquals(
      listOf("bundle is not signed"),
      ProtoViewerAabInspector.violations(read, true, true),
    )
  }
}
