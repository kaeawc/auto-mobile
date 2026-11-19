package dev.jasonpearson.automobile.ctrlproxy

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Document
import org.w3c.dom.Element

/** CtrlProxy and ProtoViewer declare camera and microphone without requiring the hardware. */
class PrototypeCaptureManifestTest {
  @Test
  fun `prototype hosts declare camera and microphone`() {
    for (module in listOf("control-proxy", "protoviewer")) {
      val requested = elements(readManifest(module), "uses-permission").map { it.android("name") }
      assertTrue(module, requested.containsAll(CAPTURE_PERMISSIONS))
    }
  }

  @Test
  fun `capture hardware is never an install requirement`() {
    for (module in listOf("control-proxy", "protoviewer")) {
      val features =
        elements(readManifest(module), "uses-feature").associate {
          it.android("name") to it.android("required")
        }
      assertEquals(module, CAPTURE_FEATURES.associateWith { "false" }, features)
    }
  }

  private fun readManifest(module: String): Document =
    DocumentBuilderFactory.newInstance().run {
      isNamespaceAware = true
      newDocumentBuilder().parse(locateManifest(module))
    }

  private fun elements(document: Document, tagName: String): List<Element> {
    val nodes = document.getElementsByTagName(tagName)
    return (0 until nodes.length).map { nodes.item(it) as Element }
  }

  private fun Element.android(name: String): String = getAttributeNS(ANDROID_NAMESPACE, name)

  private fun locateManifest(module: String): File {
    val rel = "android/$module/src/main/AndroidManifest.xml"
    return generateSequence(File(System.getProperty("user.dir") ?: ".").absoluteFile) {
        it.parentFile
      }
      .map { File(it, rel) }
      .first { it.isFile }
  }

  private companion object {
    const val ANDROID_NAMESPACE = "http://schemas.android.com/apk/res/android"
    val CAPTURE_PERMISSIONS = listOf("android.permission.CAMERA", "android.permission.RECORD_AUDIO")
    val CAPTURE_FEATURES =
      listOf(
        "android.hardware.camera",
        "android.hardware.camera.any",
        "android.hardware.camera.autofocus",
        "android.hardware.microphone",
      )
  }
}
