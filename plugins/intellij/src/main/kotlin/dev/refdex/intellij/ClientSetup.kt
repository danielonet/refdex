package dev.refdex.intellij

import com.intellij.ide.plugins.PluginManagerCore
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.extensions.PluginId
import com.google.gson.JsonObject
import dev.refdex.intellij.clients.ClaudeCodeLocal
import dev.refdex.intellij.clients.McpConfigFile
import dev.refdex.intellij.clients.ServerCommand
import dev.refdex.intellij.daemon.DaemonLocator

/**
 * The AI clients RefDex can register with for a project. Detection only decides what to offer
 * and in what order; the MCP server behaves the same for every client.
 */
class ClientSetup private constructor(private val service: RefdexProjectService) {
    /** One place an MCP server entry can live. */
    abstract class Target(val label: String, val detail: String, private val pluginId: String?) {
        /** The client's IDE plugin is installed (or its CLI, for Claude Code). */
        open val installed: Boolean get() = pluginId != null && PluginManagerCore.isPluginInstalled(PluginId.getId(pluginId))
        /** Shown after connecting, e.g. that the client needs an IDE restart. */
        open val afterConnect: String? = null
        abstract fun entry(): JsonObject?
        abstract fun connect(cmd: ServerCommand)
        abstract fun disconnect()
        val connected: Boolean get() = entry() != null
    }

    private class FileTarget(label: String, detail: String, pluginId: String?, val file: McpConfigFile, val name: String, override val afterConnect: String? = null) :
        Target(label, detail, pluginId) {
        override fun entry() = file.entry(name)
        override fun connect(cmd: ServerCommand) = file.write(name, cmd)
        override fun disconnect() {
            file.remove(name)
        }
    }

    private val root = service.root
    private val cli = ClaudeCodeLocal.findCli(DaemonLocator::findOnPath)
    private val claudeLocal = ClaudeCodeLocal(root, cli)

    val targets: List<Target> = listOf(
        object : Target("Claude Code", "private to you, in ~/.claude.json", CLAUDE_CODE_ID) {
            override val installed get() = cli != null || super.installed
            override fun entry() = claudeLocal.entry(SERVER_NAME)
            override fun connect(cmd: ServerCommand) = claudeLocal.write(SERVER_NAME, cmd)
            override fun disconnect() = claudeLocal.remove(SERVER_NAME)
        },
        FileTarget("Claude Code (shared)", "the project's .mcp.json, for everyone who opens it", CLAUDE_CODE_ID, McpConfigFile.claudeProject(root), SERVER_NAME),
        FileTarget("Junie", "the project's .junie/mcp/mcp.json", JUNIE_ID, McpConfigFile.junieProject(root), SERVER_NAME),
        // Copilot for JetBrains reads only a global file, so each project gets its own entry name.
        FileTarget(
            "GitHub Copilot", "global mcp.json, as \"${copilotName()}\"", COPILOT_ID, McpConfigFile.copilotGlobal(), copilotName(),
            afterConnect = "Restart the IDE so Copilot loads the new MCP server.",
        ),
    )

    val aiAssistantInstalled: Boolean get() = PluginManagerCore.isPluginInstalled(PluginId.getId(AI_ASSISTANT_ID))

    /** The config AI Assistant takes in its settings; it has no file other plugins can write. */
    fun aiAssistantSnippet(): String = McpConfigFile.snippet(SERVER_NAME, service.mcpCommand())

    fun anyConnected(): Boolean = targets.any { safely { it.connected } == true }

    /**
     * Rewrites existing entries that start another command, e.g. after a plugin update moved the
     * daemon or the AI tools settings changed. Never creates an entry the user did not ask for.
     */
    fun refreshStale() {
        val cmd = try {
            service.mcpCommand()
        } catch (_: Exception) {
            return
        }
        for (target in targets) {
            val entry = safely { target.entry() } ?: continue
            if (entry.get("command")?.asString == cmd.command && entry.get("args") == cmd.toJson(false).get("args")) continue
            LOG.info("RefDex: updating the ${target.label} entry to this RefDex version and settings")
            safely { target.connect(cmd) }
        }
    }

    private fun copilotName() = "$SERVER_NAME-${root.fileName.toString().replace(Regex("[^\\w.-]"), "_")}"

    private fun <T> safely(body: () -> T): T? = try {
        body()
    } catch (e: Exception) {
        LOG.warn("RefDex: $e")
        null
    }

    companion object {
        private val LOG = logger<ClientSetup>()
        const val SERVER_NAME = "refdex"

        /** JetBrains Marketplace IDs, checked 2026-09-26. */
        const val CLAUDE_CODE_ID = "com.anthropic.code.plugin"
        const val JUNIE_ID = "org.jetbrains.junie"
        const val COPILOT_ID = "com.github.copilot"
        const val AI_ASSISTANT_ID = "com.intellij.ml.llm"

        fun forProject(service: RefdexProjectService) = ClientSetup(service)
    }
}
