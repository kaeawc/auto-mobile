package com.automobile.ide.yaml

import com.intellij.codeInspection.LocalQuickFix
import com.intellij.codeInspection.ProblemDescriptor
import com.intellij.openapi.project.Project
import com.intellij.psi.PsiElement
import com.intellij.psi.util.PsiTreeUtil
import org.jetbrains.yaml.YAMLElementGenerator
import org.jetbrains.yaml.psi.YAMLDocument
import org.jetbrains.yaml.psi.YAMLFile
import org.jetbrains.yaml.psi.YAMLKeyValue
import org.jetbrains.yaml.psi.YAMLMapping

/**
 * Quick fix to remove an unknown/additional property from the YAML
 */
class RemovePropertyQuickFix(private val propertyName: String) : LocalQuickFix {
    override fun getFamilyName(): String = "Remove unknown property '$propertyName'"

    override fun applyFix(project: Project, descriptor: ProblemDescriptor) {
        val element = descriptor.psiElement
        val keyValue = PsiTreeUtil.getParentOfType(element, YAMLKeyValue::class.java)
        keyValue?.delete()
    }
}

/**
 * Quick fix to add a missing required field to the YAML
 */
class AddRequiredFieldQuickFix(
    private val fieldName: String,
    private val defaultValue: String
) : LocalQuickFix {
    override fun getFamilyName(): String = "Add missing field '$fieldName'"

    override fun applyFix(project: Project, descriptor: ProblemDescriptor) {
        val element = descriptor.psiElement
        val file = element.containingFile as? YAMLFile ?: return
        val document = PsiTreeUtil.getChildOfType(file, YAMLDocument::class.java) ?: return
        val topLevelMapping = document.topLevelValue as? YAMLMapping ?: return

        val generator = YAMLElementGenerator.getInstance(project)
        val newKeyValue = generator.createYamlKeyValue(fieldName, defaultValue)

        topLevelMapping.putKeyValue(newKeyValue)
    }
}

/**
 * Quick fix to rename a misspelled field
 */
class RenameFieldQuickFix(
    private val oldName: String,
    private val newName: String
) : LocalQuickFix {
    override fun getFamilyName(): String = "Rename '$oldName' to '$newName'"

    override fun applyFix(project: Project, descriptor: ProblemDescriptor) {
        val element = descriptor.psiElement
        val keyValue = PsiTreeUtil.getParentOfType(element, YAMLKeyValue::class.java) ?: return

        val generator = YAMLElementGenerator.getInstance(project)
        val newKeyValue = generator.createYamlKeyValue(newName, keyValue.valueText)

        keyValue.replace(newKeyValue)
    }
}

/**
 * Quick fix to convert a deprecated field to its new equivalent
 */
class ConvertDeprecatedFieldQuickFix(
    private val deprecatedField: String,
    private val newField: String,
    private val moveToMetadata: Boolean = false
) : LocalQuickFix {
    override fun getFamilyName(): String =
        if (moveToMetadata) {
            "Move '$deprecatedField' to 'metadata.$newField'"
        } else {
            "Replace '$deprecatedField' with '$newField'"
        }

    override fun applyFix(project: Project, descriptor: ProblemDescriptor) {
        val element = descriptor.psiElement
        val keyValue = PsiTreeUtil.getParentOfType(element, YAMLKeyValue::class.java) ?: return
        val file = element.containingFile as? YAMLFile ?: return
        val document = PsiTreeUtil.getChildOfType(file, YAMLDocument::class.java) ?: return
        val topLevelMapping = document.topLevelValue as? YAMLMapping ?: return

        val generator = YAMLElementGenerator.getInstance(project)

        if (moveToMetadata) {
            // Get or create metadata mapping
            var metadataKeyValue = topLevelMapping.getKeyValueByKey("metadata")
            if (metadataKeyValue == null) {
                metadataKeyValue = generator.createYamlKeyValue("metadata", "")
                topLevelMapping.putKeyValue(metadataKeyValue)
            }

            val metadataMapping = metadataKeyValue.value as? YAMLMapping
                ?: return

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

/**
 * Factory to create quick fixes based on validation errors
 */
object TestPlanQuickFixFactory {

    /**
     * Create quick fixes for a validation error
     */
    fun createQuickFixes(error: TestPlanValidationError): List<LocalQuickFix> {
        val fixes = mutableListOf<LocalQuickFix>()

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

        // Handle missing required fields
        if (error.message.contains("Missing required property")) {
            val propertyMatch = Regex("Missing required property '([^']+)'").find(error.message)
            val property = propertyMatch?.groupValues?.getOrNull(1)

            when (property) {
                "name" -> fixes.add(AddRequiredFieldQuickFix("name", "\"my-test-plan\""))
                "steps" -> fixes.add(AddRequiredFieldQuickFix("steps", "[]"))
                "tool" -> fixes.add(AddRequiredFieldQuickFix("tool", "\"observe\""))
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
