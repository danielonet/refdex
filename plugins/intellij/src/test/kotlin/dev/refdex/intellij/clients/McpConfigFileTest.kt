package dev.refdex.intellij.clients

import com.google.gson.JsonParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.nio.file.Files

class McpConfigFileTest {
    @get:Rule val tmp = TemporaryFolder()

    private val cmd = ServerCommand("/opt/refdex", listOf("mcp", "--root", "/p", "--db", "/s/index.db"))

    @Test
    fun `adds its entry and keeps the other servers`() {
        val root = tmp.root.toPath()
        Files.writeString(root.resolve(".mcp.json"), """{"mcpServers": {"other": {"command": "x"}}, "keep": 1}""")
        val file = McpConfigFile.claudeProject(root)
        file.write("refdex", cmd)
        val json = JsonParser.parseString(Files.readString(file.path)).asJsonObject
        assertEquals("x", json.getAsJsonObject("mcpServers").getAsJsonObject("other").get("command").asString)
        assertEquals(1, json.get("keep").asInt)
        val entry = file.entry("refdex")!!
        assertEquals("stdio", entry.get("type").asString)
        assertEquals("/opt/refdex", entry.get("command").asString)
        assertEquals("--db", entry.getAsJsonArray("args")[3].asString)
    }

    @Test
    fun `creates Junie's folder and writes no type`() {
        val file = McpConfigFile.junieProject(tmp.root.toPath())
        file.write("refdex", cmd)
        assertTrue(Files.exists(tmp.root.toPath().resolve(".junie/mcp/mcp.json")))
        assertNull(file.entry("refdex")!!.get("type"))
    }

    @Test
    fun `Copilot keeps servers under the servers key`() {
        val file = McpConfigFile.copilotGlobal(home = tmp.root.toPath(), appData = null)
        file.write("refdex-p", cmd)
        assertEquals(tmp.root.toPath().resolve(".config/github-copilot/intellij/mcp.json"), file.path)
        assertTrue(Files.readString(file.path).contains("\"servers\""))
    }

    @Test
    fun `notices an entry that starts another command`() {
        val file = McpConfigFile.claudeProject(tmp.root.toPath())
        assertFalse(file.isStale("refdex", cmd))
        file.write("refdex", cmd.copy(command = "/old/refdex"))
        assertTrue(file.isStale("refdex", cmd))
        file.write("refdex", cmd)
        assertFalse(file.isStale("refdex", cmd))
    }

    @Test
    fun `removes only its entry`() {
        val file = McpConfigFile.claudeProject(tmp.root.toPath())
        file.write("other", cmd)
        file.write("refdex", cmd)
        assertTrue(file.remove("refdex"))
        assertFalse(file.remove("refdex"))
        assertNull(file.entry("refdex"))
        assertEquals("/opt/refdex", file.entry("other")!!.get("command").asString)
    }

    @Test
    fun `refuses to overwrite a file it cannot parse`() {
        val path = tmp.root.toPath().resolve(".mcp.json")
        Files.writeString(path, "{ not json")
        assertThrows(IllegalStateException::class.java) { McpConfigFile.claudeProject(tmp.root.toPath()).write("refdex", cmd) }
        assertEquals("{ not json", Files.readString(path))
    }

    @Test
    fun `the AI Assistant snippet is a complete mcpServers block`() {
        val json = JsonParser.parseString(McpConfigFile.snippet("refdex", cmd)).asJsonObject
        assertEquals("/opt/refdex", json.getAsJsonObject("mcpServers").getAsJsonObject("refdex").get("command").asString)
    }
}
