package dev.jasonpearson.automobile.ctrlproxy.prototype

internal data class PrototypeShaderDeclarations(val floats: Set<String>, val content: Boolean)

/** A conservative token scanner matching the host preflight, not an AGSL parser/compiler. */
internal fun prototypeShaderDeclarations(source: String): PrototypeShaderDeclarations {
  require(source.isNotEmpty() && source.toByteArray(Charsets.UTF_8).size <= 16384) {
    "AGSL source must contain 1 to 16384 UTF-8 bytes."
  }
  val stripped = shaderWithoutComments(source)
  require(stripped.all { it in ' '..'~' || it in "\t\r\n" } && stripped.none { it in "#\\\"'" }) {
    "AGSL code must be ASCII with no directives, strings or escapes."
  }
  val tokens = SHADER_TOKENS.findAll(stripped).map { it.value }.toList()
  val floats = mutableSetOf<String>()
  var content = false
  var depth = 0
  var index = 0
  while (index < tokens.size) {
    val token = tokens[index]
    if (token == "{") depth++
    if (token == "}") depth--
    if (token == "uniform") {
      require(depth == 0 && (index == 0 || tokens[index - 1] in setOf(";", "}"))) {
        "AGSL uniforms must be unqualified top-level declarations."
      }
      content = addShaderUniform(tokens, index, floats, content)
      index += 3
    }
    index++
  }
  return PrototypeShaderDeclarations(floats, content)
}

private fun addShaderUniform(
  tokens: List<String>,
  index: Int,
  floats: MutableSet<String>,
  content: Boolean,
): Boolean {
  val type = tokens.getOrNull(index + 1)
  val name = tokens.getOrNull(index + 2).orEmpty()
  require(SHADER_NAME.matches(name) && tokens.getOrNull(index + 3) == ";") {
    "AGSL uniforms must use a single scalar declaration ending in ';'."
  }
  require(
    name !in RESERVED_NAMES &&
      !RESERVED_TYPES.matches(name) &&
      !name.startsWith("sk_") &&
      !name.startsWith("gl_"),
  ) {
    "AGSL uniform name '$name' is reserved."
  }
  if (type == "shader" && name == "content" && !content) return true
  require(type == "float" && name != "content" && floats.add(name)) {
    "AGSL permits unique scalar float uniforms and only one shader input named content."
  }
  require(floats.size <= 16) { "AGSL permits at most 16 float uniforms." }
  return content
}

private fun shaderWithoutComments(source: String): String = buildString {
  var index = 0
  while (index < source.length) {
    when {
      source.startsWith("//", index) -> {
        index += 2
        while (
          index < source.length && source[index] !in "\n\r\u000b\u000c\u0085\u2028\u2029"
        ) index++
        if (index < source.length) index++
        append(' ')
      }
      source.startsWith("/*", index) -> {
        val end = source.indexOf("*/", index + 2)
        require(end >= 0) { "AGSL source has an unterminated block comment." }
        index = end + 2
        append(' ')
      }
      else -> append(source[index++])
    }
  }
}

private val SHADER_NAME = Regex("[A-Za-z_][A-Za-z0-9_]*")
private val SHADER_TOKENS = Regex("[A-Za-z_][A-Za-z0-9_]*|[^\\s]")
private val RESERVED_TYPES =
  Regex(
    "(?:(?:bool|int|uint|short|ushort|float|half|double)[234](?:x[234])?|[biudfh]?vec[234]|[dh]?mat[234](?:x[234])?|(?:[iu]?(?:image|sampler|texture))(?:1D|2D|3D|1DArray|2DArray|2DRect|2DMS|2DMSArray|Buffer|Cube|CubeArray)(?:Shadow)?|samplerShadow|[iu]?subpassInput(?:MS)?)",
  )
private val RESERVED_NAMES =
  """
  main true false if else for while do switch case default break continue discard return
  in out inout uniform const flat noperspective inline noinline readonly writeonly buffer
  struct layout highp mediump lowp workgroup pixel_local atomic attribute varying precision
  invariant asm class union enum typedef template this packed goto volatile public static
  extern external interface long double fixed unsigned superp input output sizeof cast
  namespace using then atomic_uint sampler3DRect common partition active filter resource superp row_major subroutine
  coherent restrict volatile centroid smooth patch sample shared precise precision
  void bool int uint short ushort float half shader colorFilter blender sampler texture
"""
    .trim()
    .split(Regex("\\s+"))
    .toSet()

/** Android/SkSL diagnostics use `error: N:` or `line N:` for source locations. */
internal fun prototypeShaderSourceError(message: String): String =
  SHADER_ERROR_LINE.replace(message) { match ->
    val line = match.groupValues[2].toIntOrNull() ?: return@replace match.value
    "${match.groupValues[1]}${(line - 1).coerceAtLeast(1)}:"
  }

private val SHADER_ERROR_LINE = Regex("((?:error: |line ))([0-9]+):")
