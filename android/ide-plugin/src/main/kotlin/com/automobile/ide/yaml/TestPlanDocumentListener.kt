package com.automobile.ide.yaml

import com.automobile.ide.settings.AutoMobileSettings
import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.editor.event.BulkAwareDocumentListener
import com.intellij.openapi.editor.event.DocumentEvent
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import com.intellij.psi.PsiDocumentManager
import com.intellij.util.Alarm
import org.jetbrains.yaml.psi.YAMLFile

/**
 * Document listener that triggers PSI commit for test plan YAML files on content changes.
 * This ensures error counts and highlights update in real-time without requiring file save.
 *
 * Performance characteristics:
 * - Debouncing (300ms) avoids excessive processing during rapid typing
 * - Lightweight checks run on pooled thread (not EDT)
 * - PSI access uses non-blocking read action
 * - Document commit is coalesced by IntelliJ's smart commit mechanism
 */
class TestPlanDocumentListener(
    private val project: Project,
    private val delayMs: Int = 300
) : BulkAwareDocumentListener {

    private val alarm = Alarm(Alarm.ThreadToUse.POOLED_THREAD, project)

    override fun documentChanged(event: DocumentEvent) {
        // Lightweight check on current thread
        if (!AutoMobileSettings.getInstance().enableYamlLinting) {
            return
        }

        // Debounce rapid changes to avoid excessive processing
        alarm.cancelAllRequests()

        alarm.addRequest({
            processDocumentChange(event)
        }, delayMs)
    }

    private fun processDocumentChange(event: DocumentEvent) {
        val document = event.document
        val virtualFile = FileDocumentManager.getInstance().getFile(document) ?: return

        // Early exit if not a test plan file (cheap check on pooled thread)
        if (!TestPlanDetector.isTestPlanFile(virtualFile)) {
            return
        }

        // Use non-blocking read action to check PSI off EDT
        ReadAction.nonBlocking<Boolean> {
            val psiDocumentManager = PsiDocumentManager.getInstance(project)
            val psiFile = psiDocumentManager.getPsiFile(document)

            // Return true if this is a valid YAML test plan file
            psiFile is YAMLFile && psiFile.isValid
        }
            .inSmartMode(project)
            .expireWith(project)
            .coalesceBy(this)
            .finishOnUiThread(com.intellij.openapi.application.ModalityState.nonModal()) { isValidYamlFile ->
                // Commit on EDT if valid
                if (isValidYamlFile && !project.isDisposed) {
                    PsiDocumentManager.getInstance(project).commitDocument(document)
                }
            }
            .submit(com.intellij.util.concurrency.AppExecutorUtil.getAppExecutorService())
    }

    fun dispose() {
        alarm.cancelAllRequests()
    }
}
