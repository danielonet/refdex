package dev.refdex.intellij

import com.intellij.openapi.actionSystem.ActionGroup
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.impl.SimpleDataContext
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.wm.StatusBar
import com.intellij.openapi.wm.StatusBarWidget
import com.intellij.openapi.wm.StatusBarWidgetFactory
import com.intellij.ui.awt.RelativePoint
import com.intellij.util.Consumer
import java.awt.Component
import java.awt.Point
import java.awt.event.MouseEvent
import java.text.NumberFormat

class RefdexStatusWidgetFactory : StatusBarWidgetFactory {
    override fun getId() = RefdexStatusWidget.ID
    override fun getDisplayName() = "RefDex"
    override fun isAvailable(project: Project) = project.basePath != null
    override fun createWidget(project: Project): StatusBarWidget = RefdexStatusWidget(project)
}

/** "RefDex: 80 files" with the details in its tooltip; a click opens the RefDex menu. */
class RefdexStatusWidget(private val project: Project) : StatusBarWidget, StatusBarWidget.TextPresentation {
    private var statusBar: StatusBar? = null

    override fun ID() = ID

    override fun install(statusBar: StatusBar) {
        this.statusBar = statusBar
        project.messageBus.connect(this).subscribe(RefdexProjectService.TOPIC, RefdexProjectService.Listener { statusBar.updateWidget(ID) })
    }

    override fun getPresentation() = this

    private val service get() = RefdexProjectService.getInstance(project)

    override fun getText(): String = when (val s = service.status) {
        RefdexProjectService.Status.Starting -> "RefDex"
        RefdexProjectService.Status.Indexing -> "RefDex: indexing…"
        is RefdexProjectService.Status.Failed -> "RefDex: error"
        RefdexProjectService.Status.Ready -> service.stats?.takeIf { it.files > 0 }?.let { "RefDex: ${NumberFormat.getIntegerInstance().format(it.files)} files" } ?: "RefDex: not indexed"
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
            "AI tools ${if (tools.enabled) "on" else "off"}: ${tools.reason}</html>"
    }

    override fun getAlignment() = Component.CENTER_ALIGNMENT

    override fun getClickConsumer() = Consumer<MouseEvent> { e ->
        val group = ActionManager.getInstance().getAction("RefDex.Menu") as ActionGroup
        val popup = JBPopupFactory.getInstance().createActionGroupPopup(
            "RefDex", group, SimpleDataContext.getProjectContext(project), JBPopupFactory.ActionSelectionAid.SPEEDSEARCH, false,
        )
        val size = popup.content.preferredSize
        popup.show(RelativePoint(e.component, Point(0, -size.height)))
    }

    override fun dispose() {
        statusBar = null
    }

    companion object {
        const val ID = "RefDex.Status"
    }
}
