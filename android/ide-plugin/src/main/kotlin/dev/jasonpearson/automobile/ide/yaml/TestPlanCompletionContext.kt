package dev.jasonpearson.automobile.ide.yaml

import com.intellij.openapi.util.TextRange
import com.intellij.psi.PsiElement
import com.intellij.psi.util.PsiTreeUtil
import org.jetbrains.yaml.psi.YAMLDocument
import org.jetbrains.yaml.psi.YAMLKeyValue
import org.jetbrains.yaml.psi.YAMLMapping
import org.jetbrains.yaml.psi.YAMLSequence
import org.jetbrains.yaml.psi.YAMLSequenceItem

internal object TestPlanCompletionContext {
  fun isInValue(position: PsiElement, keyValue: YAMLKeyValue): Boolean {
    val value = keyValue.value
    if (value != null && value.textRange.contains(position.textOffset)) {
      return true
    }

    val key = keyValue.key ?: return false
    val range = TextRange(key.textRange.endOffset, keyValue.textRange.endOffset)
    return range.contains(position.textOffset)
  }

  fun isTopLevelMapping(mapping: YAMLMapping): Boolean {
    return mapping.parent is YAMLDocument
  }

  fun findMetadataRootMapping(element: PsiElement): YAMLMapping? {
    var current: PsiElement? = element
    while (current != null) {
      val keyValue = PsiTreeUtil.getParentOfType(current, YAMLKeyValue::class.java) ?: return null
      if (keyValue.keyText == "metadata") {
        val parentMapping = PsiTreeUtil.getParentOfType(keyValue, YAMLMapping::class.java)
        if (parentMapping != null && isTopLevelMapping(parentMapping)) {
          return keyValue.value as? YAMLMapping
        }
      }
      current = keyValue.parent
    }
    return null
  }

  fun findStepMapping(element: PsiElement): YAMLMapping? {
    var current: PsiElement? = element
    while (current != null) {
      val sequenceItem =
        PsiTreeUtil.getParentOfType(current, YAMLSequenceItem::class.java) ?: return null
      val sequence = sequenceItem.parent as? YAMLSequence ?: return null
      val keyValue = PsiTreeUtil.getParentOfType(sequence, YAMLKeyValue::class.java)
      if (keyValue?.keyText == "steps") {
        return sequenceItem.value as? YAMLMapping
      }
      current = sequence.parent
    }
    return null
  }

  fun buildPathForMapping(
    mapping: YAMLMapping,
    rootMapping: YAMLMapping,
  ): List<SchemaPathSegment> {
    if (mapping == rootMapping) {
      return emptyList()
    }

    val segments = mutableListOf<SchemaPathSegment>()
    var current: YAMLMapping? = mapping
    while (current != null && current != rootMapping) {
      when (val parent = current.parent) {
        is YAMLSequenceItem -> {
          val sequence = parent.parent as? YAMLSequence
          val owner = sequence?.let { PsiTreeUtil.getParentOfType(it, YAMLKeyValue::class.java) }
          if (owner != null) {
            segments.add(SchemaPathSegment(owner.keyText, true))
            current = PsiTreeUtil.getParentOfType(owner, YAMLMapping::class.java)
            continue
          }
        }
        is YAMLKeyValue -> {
          segments.add(SchemaPathSegment(parent.keyText, false))
          current = PsiTreeUtil.getParentOfType(parent, YAMLMapping::class.java)
          continue
        }
      }
      current = null
    }

    return segments.reversed()
  }

  fun buildPathForKeyValue(
    keyValue: YAMLKeyValue,
    rootMapping: YAMLMapping,
  ): List<SchemaPathSegment> {
    val parentMapping =
      PsiTreeUtil.getParentOfType(keyValue, YAMLMapping::class.java) ?: return emptyList()
    val basePath = buildPathForMapping(parentMapping, rootMapping)
    return basePath + SchemaPathSegment(keyValue.keyText, false)
  }
}
