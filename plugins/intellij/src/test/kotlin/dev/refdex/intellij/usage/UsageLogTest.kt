package dev.refdex.intellij.usage

import dev.refdex.intellij.RefdexStatusWidget
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardOpenOption
import java.time.LocalDate
import java.time.ZoneOffset
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class UsageLogTest {
    private val utc = ZoneOffset.UTC

    private fun call(tool: String, client: String = "claude-code", chars: Long = 400, t: String = "2026-10-06T10:00:00Z") =
        """{"t":"$t","client":"$client","tool":"$tool","args":{"qualified_name":"A.b"},"ms":12,"chars":$chars}""" + "\n"

    private fun connect(client: String = "claude-code") = """{"t":"2026-10-06T09:59:00Z","client":"$client","event":"connect","tools":true}""" + "\n"

    private fun append(path: Path, text: String) =
        Files.writeString(path, text, StandardOpenOption.CREATE, StandardOpenOption.APPEND)

    @Test
    fun `reads the rotated and current log, then only what is appended`() {
        val dir = Files.createTempDirectory("refdex-usage")
        val path = dir.resolve("mcp-usage.jsonl")
        Files.writeString(dir.resolve("mcp-usage.jsonl.1"), call("search_symbols"))
        Files.writeString(path, connect() + call("find_references"))
        val log = UsageLog(path)

        assertEquals(listOf("search_symbols", null, "find_references"), log.readAll().map { it.tool })
        assertEquals(emptyList<UsageRecord>(), log.readNew())

        // A line written in two parts comes out once it is complete.
        val line = call("get_symbol_source")
        append(path, line.substring(0, 20))
        assertEquals(emptyList<UsageRecord>(), log.readNew())
        append(path, line.substring(20))
        assertEquals(listOf("get_symbol_source"), log.readNew().map { it.tool })

        // Rotation: the file starts over, and the new one is read from its start.
        Files.move(path, dir.resolve("mcp-usage.jsonl.1"), java.nio.file.StandardCopyOption.REPLACE_EXISTING)
        Files.writeString(path, call("get_repo_map"))
        assertEquals(listOf("get_repo_map"), log.readNew().map { it.tool })
    }

    @Test
    fun `missing log and unreadable lines are not errors`() {
        val dir = Files.createTempDirectory("refdex-usage")
        val log = UsageLog(dir.resolve("mcp-usage.jsonl"))
        assertEquals(emptyList<UsageRecord>(), log.readAll())
        assertEquals(emptyList<UsageRecord>(), log.readNew())
        Files.writeString(log.path, "not json\n" + call("search_symbols"))
        assertEquals(listOf("search_symbols"), log.readNew().map { it.tool })
    }

    @Test
    fun `summarizes calls per day and client, newest first, without connects`() {
        val records = listOf(
            UsageRecord(t = "2026-10-05T10:00:00Z", client = "claude-code", tool = "search_symbols", chars = 4000),
            UsageRecord(t = "2026-10-06T09:59:00Z", client = "claude-code", event = "connect"),
            UsageRecord(t = "2026-10-06T10:00:00Z", client = "claude-code", tool = "find_references", chars = 8000),
            UsageRecord(t = "2026-10-06T10:01:00Z", client = "Junie", tool = "get_symbol_source", chars = 400),
        )
        val summary = UsageSummary().with(records, utc)
        val today = LocalDate.parse("2026-10-06")
        assertEquals(Tally(3, 12400), summary.total)
        assertEquals(Tally(2, 8400), summary.todayTotal(today))
        assertEquals(mapOf("Claude Code" to Tally(1, 8000), "Junie" to Tally(1, 400)), summary.today(today))
        assertEquals(listOf("get_symbol_source", "find_references", "search_symbols"), summary.recent.map { it.tool })
        // More calls than fit: the newest stay.
        val more = summary.with((1..6).map { UsageRecord(t = "2026-10-06T11:0$it:00Z", client = "claude-code", tool = "t$it", chars = 4) }, utc)
        assertEquals(listOf("t6", "t5", "t4", "t3", "t2"), more.recent.map { it.tool })
    }

    @Test
    fun `describes the calls in words`() {
        assertEquals(listOf("No AI tool calls yet"), RefdexStatusWidget.usageLines(UsageSummary()))
        val now = java.time.Instant.now().toString()
        val lines = RefdexStatusWidget.usageLines(
            UsageSummary().with(listOf(UsageRecord(t = now, client = "claude-code", tool = "find_references", chars = 8400))),
        )
        assertEquals("Today: 1 call, ~2,100 tokens returned (1 in total)", lines[0])
        assertEquals("  Claude Code: 1 call, ~2,100 tokens", lines[1])
        assertEquals("Latest:", lines[2])
        assertTrue(lines[3], lines[3].matches(Regex("  \\d\\d:\\d\\d  find_references · Claude Code · ~2,100 tokens")))
    }
}
