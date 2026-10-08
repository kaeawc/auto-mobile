package dev.jasonpearson.automobile.ide.yaml

/** One hop in a validation error's path: a mapping key or a sequence index. */
sealed interface PathSegment {
  data class Key(val name: String) : PathSegment

  data class Index(val index: Int) : PathSegment
}

/**
 * Parses the `field` of a shared-validator error into path segments.
 *
 * `TestPlanValidator` emits exactly these forms (JSON pointers rewritten as `a.b[0].c`): `root` for
 * the document itself, plain keys (`steps`, `devices`), and dotted/indexed paths such as
 * `steps[3].tool`, `steps[1]`, `steps[2].steps[0]` and `steps[0].params.clock.instant`. The
 * validator does not escape `.`, `[`, `]` or `/` inside a key, so a path that crosses such a key
 * cannot be recovered; those resolve as [PathResolution.Unresolved] rather than guessing.
 */
object TestPlanErrorPath {
  private const val ROOT = "root"

  /** Returns the segments (empty for the document root), or null when [field] is malformed. */
  fun parse(field: String): List<PathSegment>? {
    if (field.isEmpty() || field == ROOT) {
      return emptyList()
    }
    val segments = mutableListOf<PathSegment>()
    var position = 0
    while (position < field.length) {
      val parsed =
        (if (field[position] == '[') parseIndex(field, position) else parseKey(field, position))
          ?: return null
      segments += parsed.segment
      position = parsed.end
    }
    return segments
  }

  /** True when [segments] address one element of the top-level `steps` list, i.e. `steps[N]`. */
  fun isStepPath(segments: List<PathSegment>): Boolean =
    segments.size == 2 &&
      (segments[0] as? PathSegment.Key)?.name == "steps" &&
      segments[1] is PathSegment.Index

  private data class Parsed(val segment: PathSegment, val end: Int)

  private fun parseIndex(field: String, start: Int): Parsed? {
    val close = field.indexOf(']', start)
    if (close < 0) {
      return null
    }
    val digits = field.substring(start + 1, close)
    if (digits.isEmpty() || !digits.all { it in '0'..'9' }) {
      return null
    }
    val index = digits.toIntOrNull() ?: return null
    return Parsed(PathSegment.Index(index), close + 1)
  }

  private fun parseKey(field: String, start: Int): Parsed? {
    // A key that follows another segment must be introduced by '.'; the first key has no prefix.
    var nameStart = start
    if (start > 0) {
      if (field[start] != '.') {
        return null
      }
      nameStart++
    }
    var nameEnd = nameStart
    while (nameEnd < field.length && field[nameEnd] != '.' && field[nameEnd] != '[') {
      nameEnd++
    }
    if (nameEnd == nameStart || field[nameStart] == ']') {
      return null
    }
    return Parsed(PathSegment.Key(field.substring(nameStart, nameEnd)), nameEnd)
  }
}

/** Result of asking a [YamlPathTree] for one child. */
sealed interface ChildLookup<out N> {
  data class Found<N>(val node: N) : ChildLookup<N>

  /** The parent is a mapping that has no such key. */
  data object KeyAbsent : ChildLookup<Nothing>

  /** The parent has the wrong shape for the segment, or the index is out of range. */
  data object NotFound : ChildLookup<Nothing>
}

/** The minimal tree surface the path walk needs; the PSI adapter and test fakes implement it. */
interface YamlPathTree<N> {
  fun child(parent: N, segment: PathSegment): ChildLookup<N>
}

/** Outcome of walking a path from the document root. */
sealed interface PathResolution<out N> {
  /** Every segment resolved; [node] is the element at the path. */
  data class Found<N>(val node: N) : PathResolution<N>

  /** Everything but a final mapping key resolved; [ancestor] is the mapping that lacks [key]. */
  data class MissingKey<N>(val ancestor: N, val key: String) : PathResolution<N>

  /** The structure no longer matches the path. */
  data object Unresolved : PathResolution<Nothing>
}

/** Walks [segments] from [root] by index and key, never searching by name across the file. */
fun <N> resolvePath(
  root: N,
  segments: List<PathSegment>,
  tree: YamlPathTree<N>,
): PathResolution<N> {
  var current = root
  for ((position, segment) in segments.withIndex()) {
    when (val lookup = tree.child(current, segment)) {
      is ChildLookup.Found -> current = lookup.node
      ChildLookup.KeyAbsent ->
        return if (position == segments.lastIndex && segment is PathSegment.Key) {
          PathResolution.MissingKey(current, segment.name)
        } else {
          PathResolution.Unresolved
        }
      ChildLookup.NotFound -> return PathResolution.Unresolved
    }
  }
  return PathResolution.Found(current)
}

/** End offset of the first line of [text], so a multi-line mapping or list highlights one line. */
fun firstLineEnd(text: String): Int = text.indexOf('\n').let { if (it < 0) text.length else it }
