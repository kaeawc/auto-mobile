package dev.jasonpearson.automobile.ctrlproxy.prototype

import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class SavedPrototypeStoreTest {
  @get:Rule val temp = TemporaryFolder()
  private val root
    get() = File(temp.root, "saved")

  private val spec =
    """{"id":"panel","window":{"placement":{"type":"fullscreen"}},"root":{"type":"text","text":"Hello"}}"""
  private val imageSpec =
    """{"id":"panel","window":{"placement":{"type":"fullscreen"}},"root":{"type":"image","asset":"hero","style":{"fontFamily":{"asset":"face"}}}}"""
  private val image = SavedPrototypeAsset("hero", "image/png", byteArrayOf(1, 2, 3))
  private val font = SavedPrototypeAsset("face", "font/ttf", byteArrayOf(4, 5))

  private fun request(id: String = "panel") =
    SavedPrototypeSaveRequest(id, "Panel", spec, emptyList())

  private fun store(
    limits: SavedPrototypeLimits = SavedPrototypeLimits(),
    clock: () -> Long = { 42L },
    fault: (String) -> Unit = {},
    files: FakeSavedPrototypeFileOperations = FakeSavedPrototypeFileOperations(),
    log: (String, Exception?) -> Unit = { _, _ -> },
  ) = SavedPrototypeDirectoryStore(root, limits, clock, fault = fault, log = log, files = files)

  private fun saved(store: SavedPrototypeStore, request: SavedPrototypeSaveRequest = request()) =
    store.save(request) as SavedPrototypeSaveResult.Saved

  private fun loaded(store: SavedPrototypeStore, id: String = "panel") =
    store.load(id) as SavedPrototypeLoadResult.Loaded

  private fun manifest(slug: String) = File(root, "$slug/manifest.json")

  private fun snapshot(): Map<String, List<Byte>> =
    if (!root.exists()) emptyMap()
    else
      root
        .walkTopDown()
        .filter { it.isFile }
        .associate { it.relativeTo(root).path to it.readBytes().toList() }

  @Test
  fun `image and font round trip includes version bytes and paths`() {
    val store = store()
    val result = saved(store, request().copy(specJson = imageSpec, assets = listOf(image, font)))
    val loaded = loaded(store)
    assertEquals(imageSpec, loaded.specJson)
    assertEquals("panel", loaded.spec.id)
    assertEquals("Panel", loaded.label)
    assertEquals(42L, loaded.savedAt)
    assertArrayEquals(image.bytes, loaded.assetBytes("hero"))
    assertArrayEquals(font.bytes, loaded.assetBytes("face"))
    assertTrue(loaded.assetFile("hero")!!.isFile)
    assertTrue(loaded.fontFile("face")!!.isFile)
    assertNull(loaded.fontFile("hero"))
    assertNull(loaded.assetBytes("missing"))
    assertEquals(
      JsonPrimitive(1),
      Json.parseToJsonElement(manifest(result.slug).readText()).jsonObject["formatVersion"],
    )
  }

  @Test
  fun `replacement keeps slug and copies unchanged assets`() {
    val events = mutableListOf<String>()
    val store = store(fault = { events += it })
    val request = request().copy(assets = listOf(image))
    val first = saved(store, request)
    events.clear()
    val second = saved(store, request.copy(label = "Updated"))
    assertTrue(second.replaced)
    assertEquals(first.slug, second.slug)
    assertEquals("Updated", loaded(store).label)
    assertEquals(1, events.count { it == "copied-asset" })
    assertFalse("wrote-asset" in events)
    assertFalse(root.list()!!.any { it.startsWith(".") })
  }

  @Test
  fun `list sorts by timestamp descending and id ascending`() {
    var now = 1L
    val store = store(clock = { now })
    saved(store, request("z"))
    now = 2L
    saved(store, request("b"))
    saved(store, request("a"))
    assertEquals(listOf("a", "b", "z"), store.list().map { it.id })
  }

  @Test
  fun `delete removes entry and unknown delete returns false`() {
    val store = store()
    saved(store)
    assertTrue(store.delete("panel"))
    assertFalse(store.delete("panel"))
    assertSame(SavedPrototypeLoadResult.NotFound, store.load("panel"))
    assertTrue(store.list().isEmpty())
  }

  private fun refused(
    request: SavedPrototypeSaveRequest,
    reason: SavedPrototypeRejection,
    limits: SavedPrototypeLimits = SavedPrototypeLimits(),
  ) {
    val store = store()
    saved(store)
    val before = snapshot()
    val result = store(limits).save(request) as SavedPrototypeSaveResult.Rejected
    assertEquals(reason, result.reason)
    assertEquals(before, snapshot())
    assertEquals(spec, loaded(store).specJson)
  }

  @Test
  fun `invalid spec preserves existing entry`() =
    refused(request().copy(specJson = "bad"), SavedPrototypeRejection.INVALID_SPEC)

  @Test
  fun `spec byte cap rejects before writing`() =
    refused(
      request(),
      SavedPrototypeRejection.SPEC_TOO_LARGE,
      SavedPrototypeLimits(maxSpecBytes = 1),
    )

  @Test
  fun `image byte cap rejects before writing`() =
    refused(
      request().copy(assets = listOf(image)),
      SavedPrototypeRejection.ASSET_TOO_LARGE,
      SavedPrototypeLimits(assets = PrototypeAssetLimits(maxAssetBytes = 2)),
    )

  @Test
  fun `font byte cap rejects before writing`() =
    refused(
      request().copy(assets = listOf(font)),
      SavedPrototypeRejection.ASSET_TOO_LARGE,
      SavedPrototypeLimits(assets = PrototypeAssetLimits(maxFontBytes = 1)),
    )

  @Test
  fun `asset count cap rejects before writing`() =
    refused(
      request().copy(assets = listOf(image, font)),
      SavedPrototypeRejection.COUNT_LIMIT,
      SavedPrototypeLimits(assets = PrototypeAssetLimits(maxCount = 1)),
    )

  @Test
  fun `total byte cap rejects before writing`() =
    refused(
      request().copy(assets = listOf(image, font)),
      SavedPrototypeRejection.TOTAL_LIMIT,
      SavedPrototypeLimits(assets = PrototypeAssetLimits(maxTotalBytes = 4)),
    )

  @Test
  fun `unknown MIME rejects before writing`() =
    refused(
      request().copy(assets = listOf(image.copy(mediaType = "../evil"))),
      SavedPrototypeRejection.UNSUPPORTED_MIME_TYPE,
    )

  @Test
  fun `duplicate asset id rejects before writing`() =
    refused(
      request().copy(assets = listOf(image, image)),
      SavedPrototypeRejection.DUPLICATE_ASSET_ID,
    )

  @Test
  fun `saved entry cap refuses a new id`() =
    refused(
      request("new"),
      SavedPrototypeRejection.SAVED_COUNT_LIMIT,
      SavedPrototypeLimits(maxSavedPrototypes = 1),
    )

  @Test
  fun `id length cap rejects before writing`() =
    refused(
      request("x".repeat(PrototypeAssetLimits().maxIdLength + 1)),
      SavedPrototypeRejection.INVALID_ID,
    )

  @Test
  fun `missing image reference rejects before writing`() =
    refused(
      request().copy(specJson = imageSpec, assets = listOf(font)),
      SavedPrototypeRejection.MISSING_ASSET,
    )

  @Test
  fun `missing font reference rejects before writing`() =
    refused(
      request().copy(specJson = imageSpec, assets = listOf(image)),
      SavedPrototypeRejection.MISSING_ASSET,
    )

  @Test
  fun `empty id rejects before writing`() = refused(request(""), SavedPrototypeRejection.INVALID_ID)

  @Test
  fun `empty label rejects before writing`() =
    refused(request().copy(label = ""), SavedPrototypeRejection.INVALID_LABEL)

  @Test
  fun `long label rejects before writing`() =
    refused(request().copy(label = "x".repeat(121)), SavedPrototypeRejection.INVALID_LABEL)

  @Test
  fun `empty asset rejects before writing`() =
    refused(
      request().copy(assets = listOf(image.copy(bytes = byteArrayOf()))),
      SavedPrototypeRejection.EMPTY_ASSET,
    )

  @Test
  fun `long asset id rejects before writing`() =
    refused(
      request()
        .copy(assets = listOf(image.copy(id = "x".repeat(PrototypeAssetLimits().maxIdLength + 1)))),
      SavedPrototypeRejection.INVALID_ASSET_ID,
    )

  @Test
  fun `invalid first save does not create root`() {
    assertTrue(store().save(request().copy(specJson = "bad")) is SavedPrototypeSaveResult.Rejected)
    assertFalse(root.exists())
  }

  @Test
  fun `replacement is allowed at saved count cap`() {
    val store = store(SavedPrototypeLimits(maxSavedPrototypes = 1))
    saved(store)
    assertTrue(saved(store).replaced)
  }

  private fun interrupted(point: String) {
    val store = store(fault = { if (it == point) throw IOException("interrupted") })
    val result = store.save(request().copy(assets = listOf(image)))
    assertTrue(result is SavedPrototypeSaveResult.Rejected)
    assertTrue(root.list()!!.any { it.startsWith(".tmp-") })
    assertTrue(store().list().isEmpty())
    assertTrue(root.list()!!.isEmpty())
    assertSame(SavedPrototypeLoadResult.NotFound, store().load("panel"))
  }

  @Test
  fun `interruption after asset write cleans staging on next use`() = interrupted("wrote-asset")

  @Test
  fun `interruption after manifest cleans staging on next use`() = interrupted("wrote-manifest")

  private class ProcessInterrupted : Error()

  @Test
  fun `process interruption between replacement renames recovers old entry`() {
    saved(store())
    val store = store(fault = { if (it == "moved-old") throw ProcessInterrupted() })
    assertThrows(ProcessInterrupted::class.java) { store.save(request().copy(label = "New")) }
    assertTrue(root.list()!!.any { it.startsWith(".old-") })
    assertEquals("Panel", loaded(store()).label)
    assertFalse(root.list()!!.any { it.startsWith(".") })
    assertEquals(1, store().list().size)
  }

  @Test
  fun `rename failure restores old entry immediately`() {
    saved(store())
    val store = store(fault = { if (it == "moved-old") throw IOException("rename failed") })
    assertTrue(store.save(request().copy(label = "New")) is SavedPrototypeSaveResult.Rejected)
    assertEquals("Panel", loaded(store()).label)
  }

  @Test
  fun `forced slug collision probes extended hash for both ids`() {
    val store =
      SavedPrototypeDirectoryStore(
        root,
        slugHash = { "a".repeat(64) },
        log = { _, _ -> },
        files = FakeSavedPrototypeFileOperations(),
      )
    val first = saved(store, request("a!"))
    val second = saved(store, request("a?"))
    assertNotEquals(first.slug, second.slug)
    assertEquals(first.slug.length + 1, second.slug.length)
    assertEquals("a!", loaded(store, "a!").id)
    assertEquals("a?", loaded(store, "a?").id)
    store.delete("a!")
    assertEquals(second.slug, saved(store, request("a?")).slug)
  }

  @Test
  fun `hostile and unicode ids have safe bounded slugs`() {
    val store = store()
    for (id in listOf("../../etc/passwd", "界".repeat(PrototypeAssetLimits().maxIdLength))) {
      val result = saved(store, request(id))
      assertTrue(Regex("[a-z0-9-]+").matches(result.slug))
      assertTrue(result.slug.length <= 45)
      assertEquals(id, loaded(store, id).id)
    }
    assertFalse(File(temp.root, "etc").exists())
  }

  private fun changeManifest(slug: String, key: String, value: JsonPrimitive) {
    val file = manifest(slug)
    val objectValue = Json.parseToJsonElement(file.readText()).jsonObject
    file.writeText(JsonObject(objectValue + (key to value)).toString())
  }

  private fun unsupported(version: Int) {
    val store = store()
    val slug = saved(store).slug
    changeManifest(slug, "formatVersion", JsonPrimitive(version))
    assertEquals(SavedPrototypeLoadResult.UnsupportedFormat(version), store.load("panel"))
    assertTrue(manifest(slug).isFile)
    assertTrue(store.list().isEmpty())
    assertTrue(manifest(slug).isFile)
  }

  @Test fun `newer format is preserved and unsupported`() = unsupported(2)

  @Test fun `older format is preserved and unsupported`() = unsupported(0)

  private fun corrupt(mutate: (File, SavedPrototypeLoadResult.Loaded) -> Unit) {
    val logs = mutableListOf<String>()
    val store = store(log = { message, _ -> logs += message })
    val slug = saved(store, request().copy(assets = listOf(image))).slug
    saved(store, request("healthy"))
    mutate(manifest(slug), loaded(store))
    assertTrue(store.load("panel") is SavedPrototypeLoadResult.Corrupt)
    assertEquals(listOf("healthy"), store.list().map { it.id })
    assertTrue(logs.any { it.startsWith("Omitting") })
  }

  @Test
  fun `garbage manifest is corrupt and healthy entries still list`() = corrupt { file, _ ->
    file.writeText("bad")
  }

  @Test
  fun `unknown manifest key is corrupt`() = corrupt { _, loaded ->
    changeManifest(loaded.slug, "extra", JsonPrimitive(true))
  }

  @Test fun `missing manifest is corrupt`() = corrupt { file, _ -> assertTrue(file.delete()) }

  @Test
  fun `invalid stored spec is corrupt`() = corrupt { _, loaded ->
    File(root, "${loaded.slug}/spec.json").writeText("invalid")
  }

  @Test
  fun `missing asset is corrupt and healthy entries still list`() = corrupt { _, loaded ->
    assertTrue(loaded.assetFile("hero")!!.delete())
  }

  @Test
  fun `hash mismatch is corrupt and healthy entries still list`() = corrupt { _, loaded ->
    loaded.assetFile("hero")!!.writeBytes(byteArrayOf(9))
  }

  @Test
  fun `manifest path traversal is corrupt`() = corrupt { file, _ ->
    val objectValue = Json.parseToJsonElement(file.readText()).jsonObject
    file.writeText(
      JsonObject(objectValue + ("specFile" to JsonPrimitive("../spec.json"))).toString(),
    )
  }

  @Test
  fun `missing and empty roots list empty`() {
    assertTrue(store().list().isEmpty())
    assertFalse(root.exists())
    assertTrue(root.mkdir())
    assertTrue(store().list().isEmpty())
  }

  @Test
  fun `unavailable root returns typed results`() {
    root.writeText("blocked")
    assertTrue(store().list().isEmpty())
    assertTrue(store().save(request()) is SavedPrototypeSaveResult.Rejected)
    assertTrue(store().load("panel") is SavedPrototypeLoadResult.Corrupt)
    assertFalse(store().delete("panel"))
    assertEquals("blocked", root.readText())
  }

  @Test
  fun `process interruption after delete rename never restores entry`() {
    saved(store())
    val deleting = store(fault = { if (it == "moved-delete") throw ProcessInterrupted() })
    assertThrows(ProcessInterrupted::class.java) { deleting.delete("panel") }
    assertTrue(root.list()!!.any { it.startsWith(".del-") })
    assertSame(SavedPrototypeLoadResult.NotFound, store().load("panel"))
    assertTrue(root.list()!!.isEmpty())
  }

  @Test
  fun `partial delete failure never restores remaining files`() {
    saved(store())
    val files = FakeSavedPrototypeFileOperations()
    var interrupted = false
    files.beforeRemove = { entry ->
      if (!interrupted) {
        interrupted = true
        assertTrue(File(entry, "spec.json").delete())
      }
      throw IOException("partial delete")
    }
    val deleting = store(SavedPrototypeLimits(maxSavedPrototypes = 1), files = files)
    assertFalse(deleting.delete("panel"))
    assertTrue(interrupted)
    assertSame(SavedPrototypeLoadResult.NotFound, deleting.load("panel"))
    assertTrue(root.list()!!.all { it.startsWith(".del-") })
    saved(deleting, request("new"))
    files.beforeRemove = {}
    assertEquals(listOf("new"), deleting.list().map { it.id })
    assertFalse(root.list()!!.any { it.startsWith(".del-") })
  }

  @Test
  fun `unreadable manifest leftover does not consume saved count cap`() {
    val store = store(SavedPrototypeLimits(maxSavedPrototypes = 1))
    val slug = saved(store).slug
    manifest(slug).writeText("bad")
    assertTrue(store.list().isEmpty())
    saved(store, request("new"))
    assertEquals(listOf("new"), store.list().map { it.id })
  }

  @Test
  fun `post commit cleanup failure is logged and save stays successful`() {
    saved(store())
    val files = FakeSavedPrototypeFileOperations()
    files.beforeRemove = { throw IOException("cleanup failed") }
    val logs = mutableListOf<String>()
    val replacing = store(files = files, log = { message, _ -> logs += message })
    val result = saved(replacing, request().copy(label = "New"))
    assertTrue(result.replaced)
    assertTrue(logs.isNotEmpty())
    assertTrue(root.list()!!.any { it.startsWith(".old-") })
    assertEquals("New", loaded(replacing).label)
    files.beforeRemove = {}
    assertEquals("New", loaded(replacing).label)
    assertFalse(root.list()!!.any { it.startsWith(".old-") })
  }

  @Test
  fun `factory memoizes canonical roots`() {
    val first = SavedPrototypeStores.inDirectory(root)
    val second = SavedPrototypeStores.inDirectory(File(root, "../saved"))
    assertSame(first, second)
  }

  @Test
  fun `future manifest with additional key is unsupported before strict decode`() {
    val store = store()
    val slug = saved(store).slug
    changeManifest(slug, "formatVersion", JsonPrimitive(2))
    changeManifest(slug, "future", JsonPrimitive(true))
    assertEquals(SavedPrototypeLoadResult.UnsupportedFormat(2), store.load("panel"))
  }

  @Test
  fun `save refuses future manifest and writes nothing`() {
    val store = store()
    val slug = saved(store).slug
    changeManifest(slug, "formatVersion", JsonPrimitive(2))
    changeManifest(slug, "future", JsonPrimitive(true))
    val before = snapshot()
    val result = store.save(request().copy(label = "New")) as SavedPrototypeSaveResult.Rejected
    assertEquals(SavedPrototypeRejection.UNSUPPORTED_EXISTING, result.reason)
    assertEquals(before, snapshot())
  }

  @Test
  fun `save refuses parsable but invalid existing manifest`() {
    val store = store()
    val slug = saved(store).slug
    changeManifest(slug, "extra", JsonPrimitive(true))
    val before = snapshot()
    val result = store.save(request()) as SavedPrototypeSaveResult.Rejected
    assertEquals(SavedPrototypeRejection.UNSUPPORTED_EXISTING, result.reason)
    assertEquals(before, snapshot())
  }

  @Test
  fun `save refuses parsable primitive manifest`() {
    val store = store()
    val slug = saved(store).slug
    // The JSON element parser accepts this bare token as a primitive, not a manifest object.
    manifest(slug).writeText("bad")
    val before = snapshot()
    val result = store.save(request()) as SavedPrototypeSaveResult.Rejected
    assertEquals(SavedPrototypeRejection.UNSUPPORTED_EXISTING, result.reason)
    assertEquals(before, snapshot())
  }

  @Test
  fun `save refuses corrupt spec when manifest remains parsable`() {
    val store = store()
    val slug = saved(store).slug
    File(root, "$slug/spec.json").writeText("bad")
    val before = snapshot()
    val result = store.save(request()) as SavedPrototypeSaveResult.Rejected
    assertEquals(SavedPrototypeRejection.UNSUPPORTED_EXISTING, result.reason)
    assertEquals(before, snapshot())
  }

  @Test
  fun `unparsable manifest can be replaced only at derived slug`() {
    val store = store()
    val slug = saved(store).slug
    manifest(slug).writeText("{")
    val unrelated = File(root, "unrelated")
    assertTrue(unrelated.mkdir())
    File(unrelated, "manifest.json").writeText("{")
    val result = saved(store)
    assertEquals(slug, result.slug)
    assertTrue(result.replaced)
    assertEquals("{", File(unrelated, "manifest.json").readText())
  }

  @Test
  fun `invalid old recovery name is logged and removed without blocking store`() {
    saved(store())
    val stray = File(root, ".old-weird name")
    assertTrue(stray.mkdir())
    val logs = mutableListOf<String>()
    val store = store(log = { message, _ -> logs += message })
    assertEquals("Panel", loaded(store).label)
    assertFalse(stray.exists())
    assertTrue(logs.isNotEmpty())
  }

  @Test
  fun `all staged files sync before commit with manifest last`() {
    val files = FakeSavedPrototypeFileOperations()
    files.beforeSync = { assertFalse(root.list()!!.any { name -> !name.startsWith(".") }) }
    saved(store(files = files), request().copy(assets = listOf(image, font)))
    assertEquals(4, files.synced.size)
    assertEquals(listOf("spec.json", "manifest.json"), files.synced.takeLast(2).map { it.name })
    assertTrue(
      files.synced.all {
        it.parentFile.name.startsWith(".tmp-") || it.parentFile.name in listOf("assets", "fonts")
      },
    )
  }

  @Test
  fun `copied assets are also synced before replacement`() {
    val files = FakeSavedPrototypeFileOperations()
    val store = store(files = files)
    val request = request().copy(assets = listOf(image))
    saved(store, request)
    files.synced.clear()
    saved(store, request)
    assertEquals(3, files.synced.size)
    assertEquals("assets", files.synced.first().parentFile.name)
    assertEquals("manifest.json", files.synced.last().name)
  }

  @Test
  fun `asset sync failure refuses save and preserves existing entry`() {
    saved(store())
    val files = FakeSavedPrototypeFileOperations()
    files.beforeSync = { throw IOException("sync failed") }
    val result = store(files = files).save(request().copy(assets = listOf(image)))
    assertTrue(result is SavedPrototypeSaveResult.Rejected)
    assertEquals("Panel", loaded(store()).label)
  }

  @Test
  fun `manifest sync failure is logged and best effort`() {
    val files = FakeSavedPrototypeFileOperations()
    files.beforeSync = { if (it.name == "manifest.json") throw IOException("sync unavailable") }
    val logs = mutableListOf<String>()
    saved(store(files = files, log = { message, _ -> logs += message }))
    assertTrue(logs.isNotEmpty())
    assertEquals("Panel", loaded(store()).label)
  }

  @Test
  fun `oversized manifest is corrupt without reading manifest bytes`() {
    val slug = saved(store()).slug
    RandomAccessFile(manifest(slug), "rw").use { it.setLength(1024L * 1024 + 1) }
    val files = FakeSavedPrototypeFileOperations()
    files.beforeReadManifest = { throw AssertionError("oversized manifest must not be read") }
    assertTrue(store(files = files).load("panel") is SavedPrototypeLoadResult.Corrupt)
  }

  @Test
  fun `consumer saves lists loads and deletes through fake interface`() {
    val store: SavedPrototypeStore = FakeSavedPrototypeStore { 7L }
    saved(store, request().copy(assets = listOf(image)))
    val summary = store.list().single()
    assertEquals(7L, summary.savedAt)
    assertArrayEquals(image.bytes, loaded(store, summary.id).assetBytes("hero"))
    assertTrue(store.delete(summary.id))
    assertSame(SavedPrototypeLoadResult.NotFound, store.load(summary.id))
  }
}
