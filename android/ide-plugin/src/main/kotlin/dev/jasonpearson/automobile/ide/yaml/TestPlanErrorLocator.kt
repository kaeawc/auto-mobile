package dev.jasonpearson.automobile.ide.yaml

import com.intellij.openapi.util.TextRange
import com.intellij.psi.PsiElement
import org.jetbrains.yaml.psi.YAMLFile
import org.jetbrains.yaml.psi.YAMLKeyValue
import org.jetbrains.yaml.psi.YAMLMapping
import org.jetbrains.yaml.psi.YAMLSequence

/**
 * Where a validation error lives in the PSI.
 *
 * @property element the element the problem is registered on. For a step-level error this is the
 *   step mapping, for `steps[N].tool` it is the value of that step's `tool` key.
 * @property rangeInElement sub-range to highlight, or null for the whole element. Composite
 *   elements highlight their first line only.
 * @property exact false when only an ancestor could be found (the path names a key that is absent),
 *   in which case no quick fix may be offered.
 */
data class ErrorLocation(
  val element: PsiElement,
  val rangeInElement: TextRange?,
  val exact: Boolean,
)

/** Resolves a validator error path to a PSI element by walking keys and indices from the root. */
object TestPlanErrorLocator {

  /** Returns null when the path is malformed or no longer matches the document structure. */
  fun locate(file: YAMLFile, field: String): ErrorLocation? {
    val segments = TestPlanErrorPath.parse(field) ?: return null
    val root = topLevelValue(file) ?: return null
    return when (val resolution = resolvePath(root, segments, PsiYamlPathTree)) {
      is PathResolution.Found ->
        ErrorLocation(resolution.node, highlightRange(resolution.node), exact = true)
      is PathResolution.MissingKey ->
        ErrorLocation(resolution.ancestor, highlightRange(resolution.ancestor), exact = false)
      PathResolution.Unresolved -> null
    }
  }

  /** The highlight for a problem that cannot be located: the first line of the file. */
  fun fileLevelRange(file: PsiElement): TextRange = TextRange(0, firstLineEnd(file.text))

  internal fun topLevelValue(file: YAMLFile): PsiElement? =
    file.documents.firstOrNull()?.topLevelValue

  internal fun topLevelMapping(file: PsiElement?): YAMLMapping? =
    (file as? YAMLFile)?.let { topLevelValue(it) as? YAMLMapping }

  private fun highlightRange(element: PsiElement): TextRange? =
    when (element) {
      is YAMLMapping,
      is YAMLSequence -> TextRange(0, firstLineEnd(element.text))
      else -> null
    }

  private object PsiYamlPathTree : YamlPathTree<PsiElement> {
    override fun child(parent: PsiElement, segment: PathSegment): ChildLookup<PsiElement> =
      when (segment) {
        is PathSegment.Key -> keyChild(parent, segment.name)
        is PathSegment.Index -> indexChild(parent, segment.index)
      }

    private fun keyChild(parent: PsiElement, name: String): ChildLookup<PsiElement> {
      val mapping = parent as? YAMLMapping ?: return ChildLookup.NotFound
      val keyValue = mapping.getKeyValueByKey(name) ?: return ChildLookup.KeyAbsent
      // An empty value (`tool:`) has no value element, so the key/value itself stands in.
      return ChildLookup.Found(keyValue.value ?: keyValue)
    }

    private fun indexChild(parent: PsiElement, index: Int): ChildLookup<PsiElement> {
      val sequence = parent as? YAMLSequence ?: return ChildLookup.NotFound
      val item = sequence.items.getOrNull(index) ?: return ChildLookup.NotFound
      return ChildLookup.Found(item.value ?: item)
    }
  }
}

/**
 * The `key: value` entry a quick fix should edit, found relative to the element the problem was
 * registered on rather than by searching the file. Returns null (so the fix does nothing) when the
 * element does not correspond to [name]; a fix must never edit a different entry.
 */
internal fun keyValueNamed(element: PsiElement, name: String): YAMLKeyValue? =
  when (element) {
    is YAMLKeyValue -> element.takeIf { it.keyText == name }
    is YAMLMapping -> element.getKeyValueByKey(name)
    is YAMLFile -> TestPlanErrorLocator.topLevelMapping(element)?.getKeyValueByKey(name)
    else -> (element.parent as? YAMLKeyValue)?.takeIf { it.keyText == name }
  }
