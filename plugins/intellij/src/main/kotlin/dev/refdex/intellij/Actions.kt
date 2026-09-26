package dev.refdex.intellij

import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.options.ShowSettingsUtil
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.ui.popup.PopupStep
import com.intellij.openapi.ui.popup.util.BaseListPopupStep
import java.awt.datatransfer.StringSelection

abstract class RefdexAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = e.project?.basePath != null
    }
}

/** Indexes new and changed files; the daemon skips files whose content is unchanged. */
class ReindexAction : RefdexAction() {
    override fun actionPerformed(e: AnActionEvent) {
        RefdexProjectService.getInstance(e.project ?: return).reindex()
    }
}

class RebuildIndexAction : RefdexAction() {
    override fun actionPerformed(e: AnActionEvent) {
        RefdexProjectService.getInstance(e.project ?: return).rebuild()
    }
}

class ConnectAiClientAction : RefdexAction() {
    override fun actionPerformed(e: AnActionEvent) {
        choose(e.project ?: return)
    }

    companion object {
        private const val AI_ASSISTANT = "JetBrains AI Assistant: copy MCP config"

        /**
         * Lists the clients, installed ones first, each with where its entry goes and whether it is
         * connected; picking a connected one offers to disconnect it.
         */
        fun choose(project: Project) {
            val service = RefdexProjectService.getInstance(project)
            ApplicationManager.getApplication().executeOnPooledThread {
                // Reading ~/.claude.json and the config files happens off the UI thread.
                val setup = ClientSetup.forProject(service)
                val targets = setup.targets.sortedByDescending { it.installed }
                val labels = targets.associateBy { t ->
                    "${t.label}${if (t.connected) " ✓ connected" else if (!t.installed) " (not installed)" else ""} — ${t.detail}"
                }
                val items = labels.keys.toList() + AI_ASSISTANT
                ApplicationManager.getApplication().invokeLater {
                    if (project.isDisposed) return@invokeLater
                    val step = object : BaseListPopupStep<String>("Connect RefDex to an AI Client", items) {
                        override fun onChosen(selected: String, finalChoice: Boolean): PopupStep<*>? {
                            doFinalStep {
                                if (selected == AI_ASSISTANT) copyAiAssistantConfig(project, setup) else labels[selected]?.let { toggle(project, service, it) }
                            }
                            return FINAL_CHOICE
                        }
                    }
                    JBPopupFactory.getInstance().createListPopup(step).showCenteredInCurrentWindow(project)
                }
            }
        }

        private fun toggle(project: Project, service: RefdexProjectService, target: ClientSetup.Target) {
            val disconnect = target.connected
            if (disconnect && Messages.showYesNoDialog(project, "Remove RefDex from ${target.label} (${target.detail})?", "RefDex", null) != Messages.YES) return
            if (!disconnect && !service.aiTools().enabled &&
                Messages.showYesNoDialog(
                    project,
                    "RefDex's tools are off for this project right now (${service.aiTools().reason}), so ${target.label} will see no tools until that changes. Connect anyway?",
                    "RefDex", null,
                ) != Messages.YES
            ) return
            ApplicationManager.getApplication().executeOnPooledThread {
                try {
                    if (disconnect) target.disconnect() else target.connect(service.mcpCommand())
                    service.notify(
                        if (disconnect) "Removed RefDex from ${target.label}."
                        else listOfNotNull("Connected RefDex to ${target.label} (${target.detail}).", target.afterConnect).joinToString(" "),
                    )
                } catch (e: Exception) {
                    service.notify("${target.label}: ${e.message}", NotificationType.ERROR)
                }
            }
        }

        private fun copyAiAssistantConfig(project: Project, setup: ClientSetup) {
            CopyPasteManager.getInstance().setContents(StringSelection(setup.aiAssistantSnippet()))
            RefdexProjectService.getInstance(project).notify(
                "Copied RefDex's MCP config. Paste it in Settings | Tools | AI Assistant | Model Context Protocol (Add, then \"As JSON\").",
            )
        }
    }
}

class OpenSettingsAction : RefdexAction() {
    override fun actionPerformed(e: AnActionEvent) {
        ShowSettingsUtil.getInstance().showSettingsDialog(e.project, RefdexConfigurable::class.java)
    }
}
