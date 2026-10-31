package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.models.UIElementInfo
import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Test

/**
 * Baseline-wrapper pruning on real device captures (#13956): the committed wire fixtures under
 * `test/fixtures/android-*` came from emulators, so the node counts and the selector-safety rule
 * below are measured on real trees, not hand-written ones.
 */
internal class ViewHierarchyExtractorWrapperPruningFixturesTest {
  private class Capture(val name: String, val root: UIElementInfo)

  /** Fixture path relative to the repo root, and the least reduction the capture must show. */
  private val expectedReduction =
    mapOf(
      "android-ime-window/playground-gboard-api36.json" to 0.20,
      "android-focus/playground-text-field-post-tap.json" to 0.20,
      "android-focus/playground-text-field-pre-tap.json" to 0.20,
      "android-overlay-window/app-layer-overlay-over-playground.raw.json" to 0.20,
      "android-overlay-window/floating-overlay-over-button-elevated.raw.json" to 0.20,
      "android-launcher/launcher-allapps-emulator-5600.json" to 0.05,
      "android-launcher/launcher-folder-emulator-5600.json" to 0.10,
      "android-launcher/launcher-home-emulator-5600.json" to 0.10,
      "android-launcher/launcher-recents-emulator-5600.json" to 0.08,
      "android-launcher/launcher-widgets-emulator-5600.json" to 0.10,
    )

  private val pruning = ViewHierarchyExtractor(pruneBaselineWrappers = true)

  @Test
  fun `captured trees shrink and no selector-relevant node is lost`() {
    for ((path, minimum) in expectedReduction) {
      val capture = captures.getValue(path)
      val before = flatten(capture.root)
      val after = pruning.optimizeHierarchy(capture.root).flatMap(::flatten)

      val reduction = 1.0 - after.size.toDouble() / before.size
      assertTrue(
        "$path reduced ${"%.2f".format(java.util.Locale.ROOT, reduction)}, wanted $minimum",
        reduction >= minimum,
      )

      assertEquals(
        "$path lost nodes a selector or tap can reach",
        emptyList<UIElementInfo>(),
        lost(before, after),
      )
    }
  }

  @Test
  fun `pruning keeps every node that has a resource id, text, description or a click handler`() {
    var checked = 0
    for (capture in captures.values) {
      val before = flatten(capture.root)
      val after = pruning.optimizeHierarchy(capture.root).flatMap(::flatten)
      assertEquals(capture.name, emptyList<UIElementInfo>(), lost(before, after))
      checked += before.count(::selectorRelevant)
    }
    assertTrue("the fixtures hold selector-relevant nodes", checked > 100)
  }

  /**
   * Replays pruning over the API 30-36 captures taken with pruning forced off. The count is window
   * root nodes only; the device-on count is the same screen captured with the API default (on). API
   * 34-36 replay to exactly the device-on count, which pins the replay to device behaviour. On API
   * 30-33 androidx writes an all-false `BOOLEAN_PROPERTY_KEY` bitmask on every node, which the
   * device build treated as meaningful, so the replay must now prune past the device-on count.
   */
  @Test
  fun `API 30-36 off captures replay to the pinned pruned counts without losing a selector`() {
    for ((api, counts) in apiLevelCounts) {
      val (deviceOn, replayed) = counts
      val off = apiLevelCaptures.getValue("a$api-off.json")
      val before = off.flatMap(::flatten)
      val after = off.flatMap(pruning::optimizeWindowRoot).flatMap(::flatten)

      assertEquals(
        "API $api device-on",
        deviceOn,
        apiLevelCaptures.getValue("a$api-on.json").sumOf { flatten(it).size },
      )
      assertEquals("API $api replayed", replayed, after.size)
      assertEquals(
        "API $api lost nodes a selector or tap can reach",
        emptyList<UIElementInfo>(),
        lost(before, after),
      )
      if (api >= 34) assertEquals("API $api replay matches the device", deviceOn, replayed)
      else assertTrue("API $api replay prunes past the device", replayed < deviceOn)
    }
  }

  /** API level to (device-on window-root nodes, replayed window-root nodes). */
  private val apiLevelCounts =
    mapOf(
      30 to (55 to 0),
      31 to (57 to 0),
      32 to (40 to 0),
      33 to (41 to 0),
      34 to (33 to 0),
      35 to (34 to 0),
      36 to (34 to 0),
    )

  /**
   * Selector-relevant nodes present before pruning and missing after, compared by their own fields.
   */
  private fun lost(before: List<UIElementInfo>, after: List<UIElementInfo>): List<UIElementInfo> {
    val remaining = after.groupingBy(::ownFields).eachCount().toMutableMap()
    return before.filter(::selectorRelevant).filter { node ->
      val key = ownFields(node)
      val left = remaining[key] ?: 0
      if (left > 0) remaining[key] = left - 1
      left == 0
    }
  }

  private fun ownFields(node: UIElementInfo): UIElementInfo =
    node.copy(node = null, children = emptyList())

  /**
   * What a selector names or a tap can reach: any identifying string, any interaction flag, or a
   * real click or long-click action. Wider than the extractor's own criteria on purpose, so the
   * test fails if a field a selector could use stops protecting its node.
   */
  private fun selectorRelevant(node: UIElementInfo): Boolean =
    listOf(
        node.resourceId,
        node.text,
        node.contentDesc,
        node.testTag,
        node.uniqueId,
        node.containerTitle,
        node.role,
        node.stateDescription,
        node.hintText,
        node.paneTitle,
        node.errorMessage,
        node.tooltipText,
      )
      .any { !it.isNullOrBlank() } ||
      listOf(
          node.clickable,
          node.longClickable,
          node.scrollable,
          node.focusable,
          node.checkable,
          node.selected,
        )
        .any { it == "true" } ||
      node.actions?.any { it == "click" || it == "long_click" } == true

  private fun flatten(node: UIElementInfo): List<UIElementInfo> =
    listOf(node) + node.children.flatMap(::flatten)

  companion object {
    private val json = Json {
      ignoreUnknownKeys = true
      isLenient = true
    }
    private lateinit var captures: Map<String, Capture>
    /** `aNN-on.json`/`aNN-off.json` under android-wrapper-pruning, as window roots. */
    private lateinit var apiLevelCaptures: Map<String, List<UIElementInfo>>

    @BeforeClass
    @JvmStatic
    fun loadCaptures() {
      val files = mutableMapOf<String, Capture>()
      val names =
        listOf(
          "android-ime-window/playground-gboard-api36.json",
          "android-focus/playground-text-field-post-tap.json",
          "android-focus/playground-text-field-pre-tap.json",
          "android-overlay-window/app-layer-overlay-over-playground.raw.json",
          "android-overlay-window/floating-overlay-over-button-elevated.raw.json",
          "android-launcher/launcher-allapps-emulator-5600.json",
          "android-launcher/launcher-folder-emulator-5600.json",
          "android-launcher/launcher-home-emulator-5600.json",
          "android-launcher/launcher-recents-emulator-5600.json",
          "android-launcher/launcher-widgets-emulator-5600.json",
        )
      for (name in names) {
        val document = json.parseToJsonElement(fixture("test/fixtures/$name").readText()).jsonObject
        val root = document["hierarchy"] ?: document["viewHierarchy"]!!.jsonObject["hierarchy"]!!
        files[name] = Capture(name, decode(root.jsonObject))
      }
      captures = files
      apiLevelCaptures =
        (30..36)
          .flatMap { api -> listOf("a$api-on.json", "a$api-off.json") }
          .associateWith { name ->
            val path = "test/fixtures/android-wrapper-pruning/$name"
            val message = json.parseToJsonElement(fixture(path).readText()).jsonObject
            val hierarchy = message["data"]!!.jsonObject["hierarchy"]!!.jsonObject
            childrenOf(hierarchy["node"]).map(::decode)
          }
    }

    // Same ancestor search as the other repo-fixture tests: works from the repo root, android/,
    // or android/control-proxy/. Parsed once, outside test timing.
    private fun fixture(relativePath: String): File {
      var directory: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
      while (directory != null) {
        val candidate = File(directory, relativePath)
        if (candidate.isFile) return candidate
        directory = directory.parentFile
      }
      error("Could not locate $relativePath from user.dir=${System.getProperty("user.dir")}")
    }

    private fun decode(node: JsonObject): UIElementInfo {
      // Host-normalized captures spell bounds as [l, t, r, b]; pruning never reads them.
      val raw = if (node["bounds"] is JsonArray) JsonObject(node - "bounds") else node
      val info = json.decodeFromJsonElement(UIElementInfo.serializer(), raw)
      return info.copy(node = null, children = childrenOf(node["node"]).map(::decode))
    }

    private fun childrenOf(value: JsonElement?): List<JsonObject> =
      when (value) {
        is JsonArray -> value.map { it.jsonObject }
        is JsonObject -> listOf(value)
        else -> emptyList()
      }
  }
}
