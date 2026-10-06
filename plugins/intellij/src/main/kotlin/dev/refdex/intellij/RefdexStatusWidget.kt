package dev.refdex.intellij

import com.intellij.icons.AllIcons
import com.intellij.openapi.actionSystem.ActionGroup
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.actionSystem.Separator
import com.intellij.openapi.actionSystem.impl.SimpleDataContext
import com.intellij.openapi.project.DumbAwareAction
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.ui.popup.ListPopup
import com.intellij.openapi.wm.StatusBar
import com.intellij.openapi.wm.StatusBarWidget
import com.intellij.openapi.wm.StatusBarWidgetFactory
import com.intellij.ui.AnimatedIcon
import com.intellij.ui.RowIcon
import com.intellij.util.ui.EmptyIcon
import dev.refdex.intellij.usage.UsageRecord
import dev.refdex.intellij.usage.UsageSummary
import dev.refdex.intellij.usage.clientName
import java.text.NumberFormat
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import javax.swing.Icon

class RefdexStatusWidgetFactory : StatusBarWidgetFactory {
    override fun getId() = RefdexStatusWidget.ID
    override fun getDisplayName() = "RefDex"
    override fun isAvailable(project: Project) = project.basePath != null
    override fun createWidget(project: Project): StatusBarWidget = RefdexStatusWidget(project)
}

/**
 * The RefDex icon and "80 files · 14 calls today". For a few seconds after an AI client calls a
 * RefDex tool it shows that call instead ("find_references · Claude Code") with a spinning icon.
 * The tooltip has the details; a click shows today's calls per client and the latest ones above
 * the RefDex menu.
 */
class RefdexStatusWidget(private val project: Project) : StatusBarWidget, StatusBarWidget.MultipleTextValuesPresentation {
    private var statusBar: StatusBar? = null

    override fun ID() = ID

    override fun install(statusBar: StatusBar) {
        this.statusBar = statusBar
        project.messageBus.connect(this).subscribe(RefdexProjectService.TOPIC, RefdexProjectService.Listener { statusBar.updateWidget(ID) })
    }

    override fun getPresentation() = this

    private val service get() = RefdexProjectService.getInstance(project)

    override fun getSelectedValue(): String {
        service.activeCall()?.let { return "${it.tool} · ${clientName(it.client)}" }
        return when (service.status) {
            RefdexProjectService.Status.Starting -> "RefDex"
            RefdexProjectService.Status.Indexing -> "indexing…"
            is RefdexProjectService.Status.Failed -> "RefDex: error"
            RefdexProjectService.Status.Ready -> {
                val files = service.stats?.takeIf { it.files > 0 }?.let { "${n.format(it.files)} files" } ?: return "not indexed"
                val calls = service.usage.todayTotal().calls
                if (calls > 0) "$files · ${n.format(calls)} call${if (calls == 1) "" else "s"} today" else files
            }
        }
    }

    /** The state icon, then a dot: green with a check when an AI client is connected, red when none is. */
    override fun getIcon(): Icon {
        val state = when {
            service.activeCall() != null -> AnimatedIcon.Default.INSTANCE
            service.status is RefdexProjectService.Status.Failed -> AllIcons.General.Warning
            else -> RefdexIcons.Logo
        }
        val dot = if (service.connectedClients.isEmpty()) ConnectionDotIcon.NOT_CONNECTED else ConnectionDotIcon.CONNECTED
        return RowIcon(3, com.intellij.ui.icons.RowIcon.Alignment.CENTER).apply {
            setIcon(state, 0)
            setIcon(EmptyIcon.create(2, 1), 1)
            setIcon(dot, 2)
        }
    }

    override fun getTooltipText(): String {
        val service = service
        val status = service.status
        if (status is RefdexProjectService.Status.Failed) return "RefDex: ${status.message}"
        val stats = service.stats?.takeIf { it.files > 0 } ?: return "RefDex has no index for this project yet. Click to build it."
        val n = NumberFormat.getIntegerInstance()
        val tools = service.aiTools()
        return "<html>RefDex: ${n.format(stats.files)} files, ${n.format(stats.symbols)} symbols, " +
            "${n.format(stats.resolvedImports)}/${n.format(stats.imports)} imports resolved<br>" +
            "Last indexed ${stats.indexedAt ?: "never"}<br>" +
            "AI tools ${if (tools.enabled) "on" else "off"}: ${tools.reason}<br>" +
            connectionLine(service.connectedClients) + "<br>" +
            usageLines(service.usage).joinToString("<br>") { escape(it) } + "</html>"
    }

    /** Today's tool calls per client and the latest calls, above the RefDex menu. */
    override fun getPopup(): ListPopup {
        val group = DefaultActionGroup()
        for (line in usageLines(service.usage)) group.add(InfoLine(line))
        group.add(Separator.getInstance())
        group.addAll(ActionManager.getInstance().getAction("RefDex.Menu") as ActionGroup)
        return JBPopupFactory.getInstance().createActionGroupPopup(
            "RefDex", group, SimpleDataContext.getProjectContext(project), JBPopupFactory.ActionSelectionAid.SPEEDSEARCH, false,
        )
    }

    /** A line of text in the popup: shown greyed out, does nothing. */
    private class InfoLine(text: String) : DumbAwareAction(text) {
        override fun getActionUpdateThread() = ActionUpdateThread.BGT
        override fun update(e: AnActionEvent) {
            e.presentation.isEnabled = false
        }
        override fun actionPerformed(e: AnActionEvent) = Unit
    }

    override fun dispose() {
        statusBar = null
    }

    companion object {
        const val ID = "RefDex.Status"
        private val n: NumberFormat get() = NumberFormat.getIntegerInstance()
        private val TIME = DateTimeFormatter.ofPattern("HH:mm")

        /**
         * Tool calls in words: today's per client, with the tokens RefDex returned (about 4
         * characters each), then the latest calls. What clients sent or spent besides isn't visible
         * to RefDex.
         */
        fun usageLines(usage: UsageSummary): List<String> {
            if (usage.total.calls == 0) return listOf("No AI tool calls yet")
            val today = usage.todayTotal()
            val lines = mutableListOf(
                if (today.calls == 0) "No AI tool calls today (${n.format(usage.total.calls)} in total)"
                else "Today: ${calls(today.calls)}, ~${n.format(today.tokens)} tokens returned (${n.format(usage.total.calls)} in total)",
            )
            for ((client, tally) in usage.today().entries.sortedByDescending { it.value.calls }) {
                lines += "  $client: ${calls(tally.calls)}, ~${n.format(tally.tokens)} tokens"
            }
            lines += "Latest:"
            for (r in usage.recent) lines += "  ${timeOf(r)}  ${r.tool} · ${clientName(r.client)} · ~${n.format(r.tokens)} tokens${if (r.error != null) " · failed" else ""}"
            return lines
        }

        /** Which AI clients RefDex is registered with, as the dot shows it. */
        fun connectionLine(clients: List<String>): String =
            if (clients.isEmpty()) "Not connected to an AI client: click, then Connect AI Client…"
            else "Connected to ${clients.joinToString(", ")}"

        private fun calls(count: Int) = "${n.format(count)} call${if (count == 1) "" else "s"}"

        private fun timeOf(r: UsageRecord): String =
            runCatching { TIME.format(Instant.parse(r.t).atZone(ZoneId.systemDefault())) }.getOrDefault("--:--")

        private fun escape(text: String) = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("  ", "&nbsp;&nbsp;")
    }
}
