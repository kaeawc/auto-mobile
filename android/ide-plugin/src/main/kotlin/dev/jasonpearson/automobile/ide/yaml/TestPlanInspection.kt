package dev.jasonpearson.automobile.ide.yaml

import com.intellij.codeInspection.LocalInspectionTool
import com.intellij.codeInspection.ProblemHighlightType
import com.intellij.codeInspection.ProblemsHolder
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiElementVisitor
import dev.jasonpearson.automobile.ide.settings.AutoMobileSettings
import dev.jasonpearson.automobile.validation.TestPlanValidator
import dev.jasonpearson.automobile.validation.ValidationError as TestPlanValidationError
import dev.jasonpearson.automobile.validation.ValidationSeverity
import org.jetbrains.yaml.psi.YAMLFile

/**
 * Inspection that validates AutoMobile test plan YAML files against the schema. Can be run via Code
 * → Inspect Code for batch validation.
 */
class TestPlanInspection : LocalInspectionTool() {

  override fun buildVisitor(holder: ProblemsHolder, isOnTheFly: Boolean): PsiElementVisitor {
    return object : PsiElementVisitor() {
      override fun visitElement(element: PsiElement) {
        // Only check the root element of the file
        if (element.parent != null) {
          return
        }

        val file = element.containingFile
        if (file !is YAMLFile) {
          return
        }

        // Check if linting is enabled
        if (!AutoMobileSettings.getInstance().enableYamlLinting) {
          return
        }

        // Check if this is a test plan file
        if (!TestPlanDetector.isTestPlanFile(file.virtualFile)) {
          return
        }

        // Check if the file has minimum test plan structure
        if (!TestPlanDetector.hasMinimumTestPlanStructure(file.text)) {
          return
        }

        // Perform validation
        val result = TestPlanValidator.validateYaml(file.text)
        if (result.valid) {
          return
        }

        // Register problems
        for (error in result.errors) {
          registerError(holder, element, file, error)
        }
      }
    }
  }

  /**
   * Registers [error] on the element at its path. A path that no longer matches the document is
   * reported on the file's first line with no quick fix, and an absent key is reported on the
   * nearest existing ancestor with no quick fix, rather than guessing which entry to edit.
   */
  private fun registerError(
    holder: ProblemsHolder,
    fileElement: PsiElement,
    file: YAMLFile,
    error: TestPlanValidationError,
  ) {
    val highlightType =
      when (error.severity) {
        ValidationSeverity.ERROR -> ProblemHighlightType.ERROR
        ValidationSeverity.WARNING -> ProblemHighlightType.WARNING
      }
    val location = TestPlanErrorLocator.locate(file, error.field)
    if (location == null) {
      val range = TestPlanErrorLocator.fileLevelRange(fileElement)
      holder.registerProblem(fileElement, error.message, highlightType, range)
      return
    }

    val quickFixes =
      if (location.exact) TestPlanQuickFixFactory.createQuickFixes(error) else emptyList()
    holder.registerProblem(
      location.element,
      error.message,
      highlightType,
      location.rangeInElement,
      *quickFixes.toTypedArray(),
    )
  }

  override fun getDisplayName(): String = "AutoMobile Test Plan Validation"

  override fun getGroupDisplayName(): String = "AutoMobile"

  override fun getShortName(): String = "AutoMobileTestPlanValidation"

  override fun isEnabledByDefault(): Boolean = true
}
