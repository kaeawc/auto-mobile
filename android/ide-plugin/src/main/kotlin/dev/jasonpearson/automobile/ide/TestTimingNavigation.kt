package dev.jasonpearson.automobile.ide

import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.psi.JavaPsiFacade
import com.intellij.psi.PsiElement
import com.intellij.psi.search.GlobalSearchScope
import dev.jasonpearson.automobile.desktop.core.daemon.TestTimingEntry

internal fun navigateToTest(
  project: Project,
  entry: TestTimingEntry,
  onError: (String) -> Unit,
) {
  val target = resolveNavigationTarget(project, entry)
  if (target == null) {
    onError("Test source not found for ${entry.testClass}.${entry.testMethod}")
    return
  }

  ApplicationManager.getApplication().invokeLater {
    OpenFileDescriptor(project, target.file, target.offset).navigate(true)
  }
}

internal data class NavigationTarget(val file: VirtualFile, val offset: Int)

internal fun resolveNavigationTarget(project: Project, entry: TestTimingEntry): NavigationTarget? {
  return ReadAction.compute<NavigationTarget?, RuntimeException> {
    val psiClass =
      JavaPsiFacade.getInstance(project)
        .findClass(entry.testClass, GlobalSearchScope.projectScope(project)) ?: return@compute null
    val methodName = normalizeTestMethodName(entry.testMethod)
    val psiMethod = psiClass.findMethodsByName(methodName, false).firstOrNull()
    val element: PsiElement = psiMethod ?: psiClass
    val file = element.containingFile?.virtualFile ?: return@compute null
    NavigationTarget(file, element.textOffset)
  }
}

internal fun normalizeTestMethodName(value: String): String {
  val trimmed = value.trim()
  if (trimmed.isEmpty()) {
    return trimmed
  }
  val bracketIndex = trimmed.indexOf('[')
  val parenIndex = trimmed.indexOf('(')
  val cutIndex = listOf(bracketIndex, parenIndex).filter { it >= 0 }.minOrNull()
  return if (cutIndex != null) trimmed.substring(0, cutIndex) else trimmed
}
