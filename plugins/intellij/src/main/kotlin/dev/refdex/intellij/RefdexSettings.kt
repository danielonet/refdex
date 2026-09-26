package dev.refdex.intellij

import com.intellij.openapi.components.BaseState
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.SimplePersistentStateComponent
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.components.StoragePathMacros
import com.intellij.openapi.project.Project
import dev.refdex.intellij.daemon.DaemonOptions

/**
 * RefDex's settings for one project, the same ones as the VS Code extension's `refdex.*` settings.
 * Kept in the workspace file (.idea/workspace.xml), since the daemon path is machine-specific.
 */
@Service(Service.Level.PROJECT)
@State(name = "RefDex", storages = [Storage(StoragePathMacros.WORKSPACE_FILE)])
class RefdexSettings : SimplePersistentStateComponent<RefdexSettings.State>(State()) {
    class State : BaseState() {
        /** Glob patterns of files to index; empty means every supported file. */
        var include by list<String>()
        /** Glob patterns to skip, on top of .gitignore and the built-in excludes. */
        var exclude by list<String>()
        /** Languages to index (python, typescript, java, csharp); empty means all. */
        var languages by list<String>()
        var watch by property(true)
        /** When AI clients get the tools: auto (by codebase size), always or never. */
        var aiTools by string(AiToolsMode.AUTO.id)
        var aiToolsMinTokens by property(DEFAULT_MIN_TOKENS)
        /** A daemon to use instead of the bundled one: an executable or a refdex.cjs bundle. */
        var daemonPath by string()
    }

    fun daemonOptions() = DaemonOptions(state.exclude.toList(), state.include.toList(), state.languages.toList(), state.watch)

    val aiToolsMode: AiToolsMode get() = AiToolsMode.entries.firstOrNull { it.id == state.aiTools } ?: AiToolsMode.AUTO

    companion object {
        /** The MCP server's default (packages/server/src/mcp.ts). */
        const val DEFAULT_MIN_TOKENS = 100_000

        fun getInstance(project: Project): RefdexSettings = project.getService(RefdexSettings::class.java)
    }
}

enum class AiToolsMode(val id: String, val label: String) {
    AUTO("auto", "Automatic, by codebase size"),
    ALWAYS("always", "Always"),
    NEVER("never", "Never"),
}
