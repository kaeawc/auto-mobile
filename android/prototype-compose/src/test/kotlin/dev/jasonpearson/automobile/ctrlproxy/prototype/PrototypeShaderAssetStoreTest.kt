package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test

class PrototypeShaderAssetStoreTest {
  private class Files : PrototypeAssetFiles {
    val data = mutableMapOf<String, ByteArray>()
    var writes = 0

    override fun write(name: String, bytes: ByteArray) {
      writes++
      data[name] = bytes.copyOf()
    }

    override fun read(name: String): ByteArray? = data[name]

    override fun delete(name: String) {
      data.remove(name)
    }

    override fun deleteAll() {
      data.clear()
    }
  }

  private class Compiler : PrototypeShaderCompiler {
    var calls = 0
    var failure: String? = null

    override fun compile(source: String): Result<PrototypeCompiledShader> {
      calls++
      return failure?.let { Result.failure(IllegalArgumentException(it)) }
        ?: Result.success(FakeCompiledPrototypeShader())
    }
  }

  @Test
  fun `compiles before writing and round trips source and metadata`() {
    val files = Files()
    val compiler = Compiler()
    val store = PrototypeAssetStore(files, shaderCompiler = compiler)
    val bytes = "half4 main(float2 p) { return half4(1); }".toByteArray()
    assertTrue(store.put("effect", MIME, bytes) is PrototypeAssetPutResult.Stored)
    assertEquals(1, compiler.calls)
    assertEquals(1, files.writes)
    assertArrayEquals(bytes, store.read("effect"))
    assertEquals(
      PrototypeAssetInfo("effect", MIME, bytes.size, setOf("strength")),
      store.lookup("effect"),
    )
    assertEquals(1, store.count)
  }

  @Test
  fun `device spec validation rejects undeclared uniforms in inactive styles`() {
    validatePrototypeShaderUniforms(validShaderNode, specStore::lookup)
    val failure = runCatching {
      validatePrototypeShaderUniforms(invalidShaderNode, specStore::lookup)
    }
      .exceptionOrNull()
    assertTrue(failure?.message.orEmpty().contains("not declared"))
    assertEquals(listOf("effect"), prototypeAssetReferences(invalidShaderNode))
  }

  @Test
  fun `failed compilation stores nothing and preserves a previous valid upload`() {
    val files = Files()
    val compiler = Compiler()
    val store = PrototypeAssetStore(files, shaderCompiler = compiler)
    val original = "original".toByteArray()
    store.put("effect", MIME, original)
    compiler.failure = "Compiler says invalid source"
    val result = store.put("effect", MIME, "bad".toByteArray()) as PrototypeAssetPutResult.Rejected
    assertEquals(PrototypeAssetRejection.SHADER_COMPILE_FAILURE, result.reason)
    assertEquals(compiler.failure, result.message)
    assertEquals(1, files.writes)
    assertArrayEquals(original, store.read("effect"))
    assertEquals(1, store.count)
    store.remove("effect")
    assertNull(store.lookup("effect"))
  }

  @Test
  fun `compiler errors stop at whole UTF-8 characters within 2 KiB`() {
    val compiler = Compiler().apply { failure = "a".repeat(2045) + "😀" + "trailing" }
    val files = Files()
    val store = PrototypeAssetStore(files, shaderCompiler = compiler)
    val result = store.put("effect", MIME, byteArrayOf(32)) as PrototypeAssetPutResult.Rejected
    assertEquals("a".repeat(2045), result.message)
    assertNull(store.lookup("effect"))
    assertEquals(0, files.writes)
    assertEquals(2048, boundedPrototypeShaderError("😀".repeat(600)).toByteArray().size)
    assertEquals(2046, boundedPrototypeShaderError("€".repeat(1000)).toByteArray().size)
  }

  @Test
  fun `AGSL size and UTF-8 limits reject before compilation`() {
    val compiler = Compiler()
    val store = PrototypeAssetStore(Files(), shaderCompiler = compiler)
    assertTrue(store.put("effect", MIME, ByteArray(16384) { 32 }) is PrototypeAssetPutResult.Stored)
    val large = store.put("large", MIME, ByteArray(16385)) as PrototypeAssetPutResult.Rejected
    assertEquals(PrototypeAssetRejection.TOO_LARGE, large.reason)
    val invalid =
      store.put("bad", MIME, byteArrayOf(0xc3.toByte())) as PrototypeAssetPutResult.Rejected
    assertEquals(PrototypeAssetRejection.CONTENT_MISMATCH, invalid.reason)
    assertEquals(1, compiler.calls)
    assertEquals(1, store.count)
  }

  @Test
  fun `API below 33 has typed actionable refusal and writes nothing`() {
    val files = Files()
    val store =
      PrototypeAssetStore(
        files,
        shaderCompiler =
          AndroidPrototypeShaderCompiler({ 32 }) { _, _ -> error("must not compile") },
      )
    val result = store.put("effect", MIME, byteArrayOf(32)) as PrototypeAssetPutResult.Rejected
    assertEquals(PrototypeAssetRejection.SHADER_UNSUPPORTED_API, result.reason)
    assertTrue(result.message.contains("API 33"))
    assertEquals(0, store.count)
    assertEquals(0, files.writes)
  }

  @Test
  fun `generic cap still bounds AGSL when configured smaller`() {
    val store = PrototypeAssetStore(Files(), PrototypeAssetLimits(maxAssetBytes = 8))
    val result = store.put("effect", MIME, ByteArray(9)) as PrototypeAssetPutResult.Rejected
    assertEquals(PrototypeAssetRejection.TOO_LARGE, result.reason)
    assertTrue(result.message.contains("limit is 8"))
  }

  companion object {
    private const val MIME = "application/vnd.automobile.agsl"
    private lateinit var specStore: PrototypeAssetStore
    private lateinit var validShaderNode: PrototypeTextNode
    private lateinit var invalidShaderNode: PrototypeTextNode

    @JvmStatic
    @BeforeClass
    fun fixtures() {
      specStore = PrototypeAssetStore(Files(), shaderCompiler = Compiler())
      validShaderNode =
        PrototypeTextNode(
          text = "shaded",
          style =
            PrototypeStyle(
              shader =
                PrototypeShader(
                  "effect",
                  mapOf("strength" to 0.5),
                ),
            ),
        )
      invalidShaderNode =
        validShaderNode.copy(
          styleWhen =
            listOf(
              PrototypeStyleWhen(
                PrototypeCondition(
                  "on",
                  equals = PrototypeScalar.BooleanValue(true),
                ),
                PrototypeStyle(
                  shader =
                    PrototypeShader(
                      "effect",
                      mapOf("unknown" to 1.0),
                    ),
                ),
              ),
            ),
        )
      // Resolving fixture assets also initializes protocol/serialization classes before timing.
      prototypeAssetReferences(validShaderNode).forEach { id ->
        specStore.put(id, MIME, byteArrayOf(32))
      }
    }
  }
}
