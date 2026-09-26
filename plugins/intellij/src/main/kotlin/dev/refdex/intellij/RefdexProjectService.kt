package dev.refdex.intellij

import com.intellij.ide.plugins.PluginManagerCore
import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.PathManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.extensions.PluginId
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.Project
import com.intellij.util.messages.Topic
import dev.refdex.intellij.clients.ServerCommand
import dev.refdex.intellij.daemon.DaemonClient
import dev.refdex.intellij.daemon.DaemonEvent
import dev.refdex.intellij.daemon.DaemonLocator
import dev.refdex.intellij.daemon.DaemonNotFoundException
import dev.refdex.intellij.daemon.IndexStats
import dev.refdex.intellij.daemon.IndexSummary
import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest
import java.text.NumberFormat
import java.util.concurrent.CompletableFuture

/**
 * Everything tied to one project: its daemon, its index and its MCP command. The daemon keeps
 * the index up to date with a file watcher once the project has been indexed.
 */
@Service(Service.Level.PROJECT)
class RefdexProjectService(private val project: Project) : Disposable {
    val root: Path = Path.of(project.basePath ?: error("RefDex needs a project with a base directory"))
    val dbPath: Path = indexPathFor(root)

    @Volatile var stats: IndexStats? = null
        private set
    @Volatile var status: Status = Status.Starting
        private set

    private var daemon: DaemonClient? = null

    sealed interface Status {
        data object Starting : Status
        data object Indexing : Status
        data object Ready : Status
        data class Failed(val message: String) : Status
    }

    /** Whether AI clients get the tools, and why; see [aiTools]. */
    data class AiToolsState(val enabled: Boolean, val reason: String)

    /** Starts the daemon (a background thread: it spawns a process) and shows what the index holds. */
    fun start() {
        val client = try {
            DaemonClient(locate().with(RefdexSettings.getInstance(project).daemonOptions().serveArgs(root.toString(), dbPath.toString()))) { LOG.info(it) }
        } catch (e: DaemonNotFoundException) {
            fail(e.message!!)
            return
        }
        client.onEvent(::onEvent)
        synchronized(this) {
            daemon?.stop()
            daemon = client
        }
        LOG.info("RefDex: indexing $root; index at $dbPath")
        client.start()
        refreshStats()
        ClientSetup.forProject(this).refreshStale()
    }

    /** Settings changed: restart the daemon if its own settings did; the AI tools settings only reach new MCP commands. */
    fun settingsChanged(daemonSettings: Boolean) {
        if (daemonSettings) {
            ApplicationManager.getApplication().executeOnPooledThread(::start)
        } else {
            publish()
            ClientSetup.forProject(this).refreshStale()
        }
    }

    val indexed: Boolean get() = (stats?.files ?: 0) > 0

    fun reindex() = runIndexing("Indexing project") { it.reindex(true) }

    fun rebuild() = runIndexing("Rebuilding index") { it.rebuild() }

    private fun runIndexing(title: String, run: (DaemonClient) -> CompletableFuture<IndexSummary>) {
        val client = daemon ?: return fail("the RefDex daemon is not running")
        object : Task.Backgroundable(project, "RefDex: $title", false) {
            override fun run(indicator: ProgressIndicator) {
                indicator.isIndeterminate = true
                val summary = try {
                    run(client).get()
                } catch (e: Exception) {
                    notify("Indexing failed: ${e.cause?.message ?: e.message}", NotificationType.ERROR)
                    return
                }
                val failed = summary.failed.orEmpty()
                if (failed.isNotEmpty()) {
                    notify("${failed.size} file(s) could not be indexed, e.g. ${failed.first().path}: ${failed.first().error}", NotificationType.WARNING)
                }
            }
        }.queue()
    }

    private fun onEvent(event: DaemonEvent) {
        when (event) {
            is DaemonEvent.Indexing -> setStatus(Status.Indexing)
            is DaemonEvent.Indexed -> {
                val first = !indexed && event.stats.files > 0
                stats = event.stats
                setStatus(Status.Ready)
                if (first) offerConnect()
            }
            is DaemonEvent.Error -> {
                LOG.warn("RefDex daemon: ${event.message}")
                setStatus(Status.Failed(event.message))
            }
            is DaemonEvent.Exited -> fail("the RefDex daemon exited (${event.code})" + event.lastOutput.lines().lastOrNull { it.isNotBlank() }?.let { ": $it" }.orEmpty())
        }
    }

    private fun refreshStats() {
        daemon?.stats()?.whenComplete { s, e ->
            if (e != null) return@whenComplete fail("could not read the index: ${e.cause?.message ?: e.message}")
            stats = s
            setStatus(Status.Ready)
        }
    }

    private fun fail(message: String) {
        LOG.warn("RefDex: $message")
        setStatus(Status.Failed(message))
    }

    private fun setStatus(s: Status) {
        status = s
        publish()
    }

    private fun publish() {
        if (!project.isDisposed) project.messageBus.syncPublisher(TOPIC).stateChanged()
    }

    /**
     * Whether the tools are worth offering: the same rule as the MCP server's (server/src/mcp.ts),
     * which each client's server applies again on its own. Their definitions cost about 1,200
     * tokens per request, more than they save on a small codebase.
     */
    fun aiTools(): AiToolsState {
        val settings = RefdexSettings.getInstance(project)
        return when (settings.aiToolsMode) {
            AiToolsMode.ALWAYS -> AiToolsState(true, "always on (settings)")
            AiToolsMode.NEVER -> AiToolsState(false, "turned off in settings")
            AiToolsMode.AUTO -> {
                val s = stats?.takeIf { it.files > 0 } ?: return AiToolsState(false, "no index yet")
                val tokens = s.codeChars / 4
                val n = NumberFormat.getIntegerInstance()
                val size = "~${n.format(tokens)} tokens of code (threshold ${n.format(settings.state.aiToolsMinTokens)})"
                if (tokens >= settings.state.aiToolsMinTokens) AiToolsState(true, size) else AiToolsState(false, "small codebase: $size")
            }
        }
    }

    /** The command AI clients start for this project's index. */
    fun mcpCommand(): ServerCommand {
        val settings = RefdexSettings.getInstance(project)
        val cmd = locate().with(
            "mcp", "--root", root.toString(), "--db", dbPath.toString(),
            "--tools", settings.aiToolsMode.id, "--min-tokens", settings.state.aiToolsMinTokens.toString(),
        )
        return ServerCommand(cmd.first(), cmd.drop(1))
    }

    private fun locate() = DaemonLocator(daemonDir()).locate(RefdexSettings.getInstance(project).state.daemonPath)

    /** After the first index, suggest connecting an AI client, once per project. */
    private fun offerConnect() {
        val props = com.intellij.ide.util.PropertiesComponent.getInstance(project)
        if (props.getBoolean(OFFERED_KEY) || !aiTools().enabled || ClientSetup.forProject(this).anyConnected()) return
        props.setValue(OFFERED_KEY, true)
        NotificationGroupManager.getInstance().getNotificationGroup(NOTIFICATIONS)
            .createNotification("RefDex indexed ${stats?.files} files", "Let AI clients (Claude Code, Junie, Copilot) search and read code through RefDex.", NotificationType.INFORMATION)
            .addAction(NotificationAction.createSimpleExpiring("Connect AI client…") { ConnectAiClientAction.choose(project) })
            .notify(project)
    }

    fun notify(message: String, type: NotificationType = NotificationType.INFORMATION) {
        NotificationGroupManager.getInstance().getNotificationGroup(NOTIFICATIONS).createNotification("RefDex", message, type).notify(project)
    }

    override fun dispose() {
        synchronized(this) {
            daemon?.stop()
            daemon = null
        }
    }

    fun interface Listener {
        fun stateChanged()
    }

    companion object {
        private val LOG = logger<RefdexProjectService>()
        const val PLUGIN_ID = "dev.refdex"
        const val NOTIFICATIONS = "RefDex"
        private const val OFFERED_KEY = "refdex.connectOffered"

        @Topic.ProjectLevel
        val TOPIC = Topic(Listener::class.java, Topic.BroadcastDirection.NONE)

        fun getInstance(project: Project): RefdexProjectService = project.getService(RefdexProjectService::class.java)

        fun daemonDir(): Path = PluginManagerCore.getPlugin(PluginId.getId(PLUGIN_ID))!!.pluginPath.resolve("daemon")

        /** The IDE's system directory, like the VS Code extension's workspace storage: outside the project. */
        fun indexPathFor(root: Path): Path {
            val hash = MessageDigest.getInstance("SHA-1").digest(root.toString().toByteArray()).joinToString("") { "%02x".format(it) }.take(8)
            val key = "${root.fileName.toString().replace(Regex("[^\\w.-]"), "_")}-$hash"
            return Path.of(PathManager.getSystemPath(), "refdex", key, "index.db").also { Files.createDirectories(it.parent) }
        }
    }
}
