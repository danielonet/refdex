package dev.refdex.intellij.clients

import com.google.gson.GsonBuilder
import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.TimeUnit

/** The stdio command AI clients start: `refdex mcp --root … --db … --tools … --min-tokens …`. */
data class ServerCommand(val command: String, val args: List<String>) {
    /** The entry in an MCP config file; `type` is only written where the client expects it. */
    fun toJson(withType: Boolean): JsonObject = JsonObject().apply {
        if (withType) addProperty("type", "stdio")
        addProperty("command", command)
        add("args", JsonArray().apply { args.forEach(::add) })
    }
}

/**
 * An MCP config file holding servers under one key, merged so other servers in it are kept:
 * Claude Code's `.mcp.json` and Junie's `.junie/mcp/mcp.json` use `mcpServers`, Copilot for
 * JetBrains uses `servers`.
 */
class McpConfigFile(val path: Path, private val serversKey: String, private val withType: Boolean) {
    fun entry(name: String): JsonObject? = read()?.getAsJsonObject(serversKey)?.getAsJsonObject(name)

    fun write(name: String, cmd: ServerCommand) {
        val config = read() ?: JsonObject()
        val servers = config.getAsJsonObject(serversKey) ?: JsonObject().also { config.add(serversKey, it) }
        servers.add(name, cmd.toJson(withType))
        Files.createDirectories(path.parent)
        Files.writeString(path, GSON.toJson(config) + "\n")
    }

    /** Removes the entry; true if there was one. */
    fun remove(name: String): Boolean {
        val config = read() ?: return false
        if (config.getAsJsonObject(serversKey)?.remove(name) == null) return false
        Files.writeString(path, GSON.toJson(config) + "\n")
        return true
    }

    /** Whether the entry exists and starts a different command (after a plugin update, say). */
    fun isStale(name: String, cmd: ServerCommand): Boolean {
        val found = entry(name) ?: return false
        return found.get("command")?.asString != cmd.command || found.get("args") != cmd.toJson(false).get("args")
    }

    /** The file's JSON; null if it is missing. Refuses to overwrite a file it cannot parse. */
    private fun read(): JsonObject? {
        if (!Files.exists(path)) return null
        val text = Files.readString(path)
        if (text.isBlank()) return null
        return try {
            JsonParser.parseString(text).asJsonObject
        } catch (e: Exception) {
            throw IllegalStateException("$path is not valid JSON; fix or remove it first", e)
        }
    }

    companion object {
        val GSON = GsonBuilder().setPrettyPrinting().disableHtmlEscaping().create()!!

        /** Claude Code's shared project scope. */
        fun claudeProject(root: Path) = McpConfigFile(root.resolve(".mcp.json"), "mcpServers", withType = true)

        /** Junie's project scope, which it reads from the project root. */
        fun junieProject(root: Path) = McpConfigFile(root.resolve(".junie").resolve("mcp").resolve("mcp.json"), "mcpServers", withType = false)

        /** Copilot for JetBrains has only a global file, read when the IDE starts. */
        fun copilotGlobal(home: Path = Path.of(System.getProperty("user.home")), appData: String? = System.getenv("APPDATA")) =
            McpConfigFile(
                if (appData != null && System.getProperty("os.name").lowercase().startsWith("windows")) {
                    Path.of(appData, "github-copilot", "intellij", "mcp.json")
                } else {
                    home.resolve(".config").resolve("github-copilot").resolve("intellij").resolve("mcp.json")
                },
                "servers",
                withType = false,
            )

        /** The snippet AI Assistant's settings take (Settings | Tools | AI Assistant | Model Context Protocol). */
        fun snippet(name: String, cmd: ServerCommand): String =
            GSON.toJson(JsonObject().apply { add("mcpServers", JsonObject().apply { add(name, cmd.toJson(false)) }) })
    }
}

/**
 * Claude Code's local scope: private to this user and project, kept in ~/.claude.json and
 * changed through the `claude` CLI (`claude mcp add-json --scope local`), which owns that file.
 */
class ClaudeCodeLocal(private val root: Path, private val cli: Path?, private val home: Path = Path.of(System.getProperty("user.home"))) {
    fun entry(name: String): JsonObject? = try {
        JsonParser.parseString(Files.readString(home.resolve(".claude.json"))).asJsonObject
            .getAsJsonObject("projects")?.getAsJsonObject(root.toString())
            ?.getAsJsonObject("mcpServers")?.getAsJsonObject(name)
    } catch (_: Exception) {
        null
    }

    fun write(name: String, cmd: ServerCommand) {
        val claude = cli ?: throw IllegalStateException("the Claude Code CLI was not found (install Claude Code, or use the shared .mcp.json option)")
        // `add-json` refuses to overwrite, so replace any older entry first.
        run(claude, "mcp", "remove", name, "--scope", "local", check = false)
        run(claude, "mcp", "add-json", name, McpConfigFile.GSON.toJson(cmd.toJson(true)), "--scope", "local")
    }

    fun remove(name: String) {
        cli?.let { run(it, "mcp", "remove", name, "--scope", "local") }
    }

    private fun run(cli: Path, vararg args: String, check: Boolean = true) {
        val proc = ProcessBuilder(listOf(cli.toString(), *args)).directory(root.toFile()).redirectErrorStream(true).start()
        val output = proc.inputStream.bufferedReader().readText()
        if (!proc.waitFor(30, TimeUnit.SECONDS)) {
            proc.destroyForcibly()
            throw IllegalStateException("claude ${args.first()} timed out")
        }
        if (check && proc.exitValue() != 0) throw IllegalStateException("claude ${args.joinToString(" ")} failed: ${output.trim()}")
    }

    companion object {
        /** The CLI on PATH, or where Claude Code's native installer puts it. */
        fun findCli(findOnPath: (String) -> Path?): Path? {
            val exe = if (System.getProperty("os.name").lowercase().startsWith("windows")) "claude.exe" else "claude"
            return findOnPath(exe) ?: Path.of(System.getProperty("user.home"), ".local", "bin", exe).takeIf { Files.isExecutable(it) }
        }
    }
}
