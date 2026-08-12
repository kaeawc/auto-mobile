package dev.jasonpearson.automobile.ctrlproxy

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Document
import org.w3c.dom.Element

class NetworkControlPermissionManifestTest {

  @Test
  fun `SDK manifest does not define network control permission`() {
    val permissions = permissionDefinitions(readManifest("auto-mobile-sdk"))

    assertFalse(
      "The SDK library must not define $NETWORK_CONTROL_PERMISSION because every SDK host would " +
        "become its owner after manifest merging.",
      permissions.any { it.name == NETWORK_CONTROL_PERMISSION },
    )
    assertFalse(
      "The SDK library must not retain the legacy permission because released SDK hosts own it.",
      permissions.any { it.name == LEGACY_NETWORK_CONTROL_PERMISSION },
    )
  }

  @Test
  fun `CtrlProxy owns and requests only the V2 network control permission`() {
    val document = readManifest("control-proxy")
    val definitions = permissionDefinitions(document)

    assertEquals(
      "CtrlProxy must be the sole signature-permission owner.",
      listOf("signature"),
      definitions.filter { it.name == NETWORK_CONTROL_PERMISSION }.map { it.protectionLevel },
    )
    assertTrue(
      "CtrlProxy must request $NETWORK_CONTROL_PERMISSION to send protected control broadcasts.",
      usesPermissions(document).contains(NETWORK_CONTROL_PERMISSION),
    )
    assertFalse(
      "The legacy permission cannot provide a secure cross-signed compatibility path. Compatible " +
        "SDK and CtrlProxy artifacts must be released together.",
      usesPermissions(document).contains(LEGACY_NETWORK_CONTROL_PERMISSION),
    )
    assertFalse(
      "CtrlProxy must not claim the legacy permission that released SDK hosts already own.",
      definitions.any { it.name == LEGACY_NETWORK_CONTROL_PERMISSION },
    )
  }

  private fun readManifest(module: String): Document =
    DocumentBuilderFactory.newInstance().run {
      isNamespaceAware = true
      newDocumentBuilder().parse(locateManifest(module))
    }

  private fun permissionDefinitions(document: Document): List<PermissionDefinition> =
    elements(document, "permission").map { element ->
      PermissionDefinition(
        name = element.androidAttribute("name"),
        protectionLevel = element.androidAttribute("protectionLevel"),
      )
    }

  private fun usesPermissions(document: Document): List<String> =
    elements(document, "uses-permission").map { it.androidAttribute("name") }

  private fun elements(document: Document, tagName: String): List<Element> {
    val nodes = document.getElementsByTagName(tagName)
    return (0 until nodes.length).map { nodes.item(it) as Element }
  }

  private fun Element.androidAttribute(name: String): String =
    getAttributeNS(ANDROID_NAMESPACE, name)

  private fun locateManifest(module: String): File {
    val rel = "$module/src/main/AndroidManifest.xml"
    val direct = listOf(File("../$rel"), File(rel), File("android/$rel")).firstOrNull { it.isFile }
    if (direct != null) return direct

    var directory = File(System.getProperty("user.dir") ?: ".").absoluteFile
    while (true) {
      val candidate = File(directory, "android/$rel")
      if (candidate.isFile) return candidate
      directory = directory.parentFile ?: break
    }

    error("Could not locate $rel from user.dir=${System.getProperty("user.dir")}")
  }

  private data class PermissionDefinition(val name: String, val protectionLevel: String)

  private companion object {
    const val ANDROID_NAMESPACE = "http://schemas.android.com/apk/res/android"
    const val NETWORK_CONTROL_PERMISSION =
      "dev.jasonpearson.automobile.ctrlproxy.permission.NETWORK_CONTROL_V2"
    const val LEGACY_NETWORK_CONTROL_PERMISSION =
      "dev.jasonpearson.automobile.sdk.permission.NETWORK_CONTROL"
  }
}
