package dev.jasonpearson.automobile.ide.yaml

import com.intellij.codeInspection.LocalQuickFix
import com.intellij.codeInspection.ProblemDescriptor
import com.intellij.openapi.project.Project
import com.intellij.psi.PsiElement
import dev.jasonpearson.automobile.validation.ValidTools
import dev.jasonpearson.automobile.validation.ValidationError as TestPlanValidationError
import dev.jasonpearson.automobile.validation.ValidationSeverity
import org.jetbrains.yaml.YAMLElementGenerator
import org.jetbrains.yaml.psi.YAMLFile
import org.jetbrains.yaml.psi.YAMLMapping

/**
 * Quick fix to remove an unknown/additional property from the YAML. The problem is registered on
 * the entry itself or on the mapping that holds it; the fix removes the entry named [propertyName]
 * relative to that element and nothing else.
 */
class RemovePropertyQuickFix(private val propertyName: String) : LocalQuickFix {
  override fun getFamilyName(): String = "Remove unknown property '$propertyName'"

  override fun applyFix(project: Project, descriptor: ProblemDescriptor) {
    keyValueNamed(descriptor.psiElement, propertyName)?.delete()
  }
}

/**
 * Quick fix to add a missing required field. It inserts into the mapping the problem was registered
 * on: the plan's top-level mapping for `name`/`steps`, the failing step's own mapping for `tool`.
 * It never overwrites a key that already exists.
 */
class AddRequiredFieldQuickFix(private val fieldName: String, private val defaultValue: String) :
  LocalQuickFix {
  override fun getFamilyName(): String = "Add missing field '$fieldName'"

  override fun applyFix(project: Project, descriptor: ProblemDescriptor) {
    val mapping = targetMapping(descriptor.psiElement) ?: return
    if (mapping.getKeyValueByKey(fieldName) != null) {
      return
    }

    val generator = YAMLElementGenerator.getInstance(project)
    val newKeyValue = generator.createYamlKeyValue(fieldName, defaultValue)

    mapping.putKeyValue(newKeyValue)
  }

  private fun targetMapping(element: PsiElement): YAMLMapping? =
    when (element) {
      is YAMLMapping -> element
      is YAMLFile -> TestPlanErrorLocator.topLevelMapping(element)
      else -> null
    }
}

/** Quick fix to rename a misspelled field */
class RenameFieldQuickFix(private val oldName: String, private val newName: String) :
  LocalQuickFix {
  override fun getFamilyName(): String = "Rename '$oldName' to '$newName'"

  override fun applyFix(project: Project, descriptor: ProblemDescriptor) {
    val keyValue = keyValueNamed(descriptor.psiElement, oldName) ?: return

    val generator = YAMLElementGenerator.getInstance(project)
    val newKeyValue = generator.createYamlKeyValue(newName, keyValue.valueText)

    keyValue.replace(newKeyValue)
  }
}

/** Quick fix to convert a deprecated field to its new equivalent */
class ConvertDeprecatedFieldQuickFix(
  private val deprecatedField: String,
  private val newField: String,
  private val moveToMetadata: Boolean = false,
) : LocalQuickFix {
  override fun getFamilyName(): String =
    if (moveToMetadata) {
      "Move '$deprecatedField' to 'metadata.$newField'"
    } else {
      "Replace '$deprecatedField' with '$newField'"
    }

  override fun applyFix(project: Project, descriptor: ProblemDescriptor) {
    val element = descriptor.psiElement
    val keyValue = keyValueNamed(element, deprecatedField) ?: return
    val topLevelMapping = TestPlanErrorLocator.topLevelMapping(element.containingFile) ?: return

    val generator = YAMLElementGenerator.getInstance(project)

    if (moveToMetadata) {
      // Get or create metadata mapping
      var metadataKeyValue = topLevelMapping.getKeyValueByKey("metadata")
      if (metadataKeyValue == null) {
        metadataKeyValue = generator.createYamlKeyValue("metadata", "")
        topLevelMapping.putKeyValue(metadataKeyValue)
      }

      val metadataMapping = metadataKeyValue.value as? YAMLMapping ?: return

      // Move the value to metadata
      val newKeyValue = generator.createYamlKeyValue(newField, keyValue.valueText)
      metadataMapping.putKeyValue(newKeyValue)

      // Remove the deprecated field
      keyValue.delete()
    } else {
      // Simple rename
      val newKeyValue = generator.createYamlKeyValue(newField, keyValue.valueText)
      keyValue.replace(newKeyValue)
    }
  }
}

/** Quick fix to fix an invalid tool name with a suggestion */
class FixToolNameQuickFix(private val currentName: String, private val suggestedName: String) :
  LocalQuickFix {
  override fun getFamilyName(): String = "Change tool to '$suggestedName'"

  override fun applyFix(project: Project, descriptor: ProblemDescriptor) {
    // The problem is registered on this step's `tool` value, so this edits only that entry.
    val keyValue = keyValueNamed(descriptor.psiElement, "tool") ?: return

    val generator = YAMLElementGenerator.getInstance(project)
    val newKeyValue = generator.createYamlKeyValue("tool", suggestedName)

    keyValue.replace(newKeyValue)
  }
}

/** Factory to create quick fixes based on validation errors */
object TestPlanQuickFixFactory {

  /** Find similar tool names using Levenshtein distance */
  private fun findSimilarTools(toolName: String, maxDistance: Int = 3): List<String> {
    return ValidTools.TOOLS.map { validTool ->
        validTool to levenshteinDistance(toolName.lowercase(), validTool.lowercase())
      }
      .filter { (_, distance) -> distance <= maxDistance }
      .sortedBy { (_, distance) -> distance }
      .take(3)
      .map { (tool, _) -> tool }
  }

  /** Calculate Levenshtein distance between two strings */
  private fun levenshteinDistance(s1: String, s2: String): Int {
    val costs = IntArray(s2.length + 1) { it }
    for (i in 1..s1.length) {
      var lastValue = i
      for (j in 1..s2.length) {
        val newValue =
          if (s1[i - 1] == s2[j - 1]) {
            costs[j - 1]
          } else {
            minOf(costs[j - 1], lastValue, costs[j]) + 1
          }
        costs[j - 1] = lastValue
        lastValue = newValue
      }
      costs[s2.length] = lastValue
    }
    return costs[s2.length]
  }

  /** Create quick fixes for a validation error */
  fun createQuickFixes(error: TestPlanValidationError): List<LocalQuickFix> {
    val fixes = mutableListOf<LocalQuickFix>()
    val path = TestPlanErrorPath.parse(error.field)

    // Handle deprecated fields
    when {
      error.field == "generated" && error.severity == ValidationSeverity.WARNING -> {
        fixes.add(ConvertDeprecatedFieldQuickFix("generated", "createdAt", moveToMetadata = true))
        fixes.add(RemovePropertyQuickFix("generated"))
      }
      error.field == "appId" && error.severity == ValidationSeverity.WARNING -> {
        fixes.add(ConvertDeprecatedFieldQuickFix("appId", "appId", moveToMetadata = true))
        fixes.add(RemovePropertyQuickFix("appId"))
      }
      error.field == "parameters" && error.severity == ValidationSeverity.WARNING -> {
        fixes.add(RemovePropertyQuickFix("parameters"))
      }
      error.field.endsWith(".description") && error.severity == ValidationSeverity.WARNING -> {
        fixes.add(RenameFieldQuickFix("description", "label"))
      }
    }

    // Handle unknown tool names
    if (error.message.contains("Unknown tool")) {
      val toolMatch = Regex("Unknown tool '([^']+)'").find(error.message)
      val toolName = toolMatch?.groupValues?.getOrNull(1)
      if (toolName != null) {
        val similarTools = findSimilarTools(toolName)
        similarTools.forEach { suggestedTool ->
          fixes.add(FixToolNameQuickFix(toolName, suggestedTool))
        }
      }
    }

    // Handle missing required fields
    if (error.message.contains("Missing required property")) {
      val propertyMatch = Regex("Missing required property '([^']+)'").find(error.message)
      val property = propertyMatch?.groupValues?.getOrNull(1)

      // Each variant is offered only where the error's path says it belongs: `name`/`steps` are
      // plan-level (path `root`), `tool` belongs to a step (path `steps[N]`).
      when {
        property == "name" && path?.isEmpty() == true ->
          fixes.add(AddRequiredFieldQuickFix("name", "\"my-test-plan\""))
        property == "steps" && path?.isEmpty() == true ->
          fixes.add(AddRequiredFieldQuickFix("steps", "[]"))
        property == "tool" && path != null && TestPlanErrorPath.isStepPath(path) ->
          fixes.add(AddRequiredFieldQuickFix("tool", "\"observe\""))
      }
    }

    // Handle unknown properties
    if (error.message.contains("Unknown property") || error.message.contains("not allowed")) {
      val propertyMatch = Regex("property '([^']+)'").find(error.message)
      val property = propertyMatch?.groupValues?.getOrNull(1)
      if (property != null) {
        fixes.add(RemovePropertyQuickFix(property))

        // Suggest common typos
        when (property) {
          "tools" -> fixes.add(RenameFieldQuickFix("tools", "tool"))
          "step" -> fixes.add(RenameFieldQuickFix("step", "steps"))
          "param" -> fixes.add(RenameFieldQuickFix("param", "params"))
        }
      }
    }

    return fixes
  }
}
