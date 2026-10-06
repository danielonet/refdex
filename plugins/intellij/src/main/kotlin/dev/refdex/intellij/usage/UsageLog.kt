package dev.refdex.intellij.usage

import com.google.gson.Gson
import com.google.gson.JsonObject
import java.io.RandomAccessFile
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/**
 * One line of the MCP server's usage log (packages/server/src/usage.ts): a tool call, or with
 * `event = "connect"` a client starting a session.
 */
data class UsageRecord(
    val t: String? = null,
    val client: String? = null,
    val clientVersion: String? = null,
    val event: String? = null,
    val tool: String? = null,
    val args: JsonObject? = null,
    val ms: Long? = null,
    /** Characters returned to the client; about 4 per token. */
    val chars: Long? = null,
    val error: String? = null,
) {
    val isCall: Boolean get() = tool != null

    /** The local day the call was made on, for "today" counts. */
    fun day(zone: ZoneId = ZoneId.systemDefault()): LocalDate? =
        runCatching { Instant.parse(t).atZone(zone).toLocalDate() }.getOrNull()

    val tokens: Long get() = (chars ?: 0) / 4
}

/** How clients name themselves in MCP's `initialize`, as people know them. */
fun clientName(raw: String?): String = when (raw) {
    null, "", "unknown" -> "unknown client"
    "claude-code" -> "Claude Code"
    "Visual Studio Code", "Visual Studio Code - Insiders" -> "Copilot (VS Code)"
    else -> raw
}

/**
 * The usage log the MCP server appends to beside the index. The MCP server runs in each AI
 * client's own process, so this file is how the IDE learns about tool calls. [readAll] reads what
 * is there (the rotated `.1` file too); [readNew] then returns only what was appended since, like
 * `tail -f`, and starts over after the server rotates the log.
 */
class UsageLog(val path: Path) {
    private val gson = Gson()
    private var offset = 0L
    private var partial = ""

    /** Every record so far, oldest first; afterwards [readNew] continues from the end. */
    fun readAll(): List<UsageRecord> {
        val rotated = path.resolveSibling("${path.fileName}.1")
        val text = listOf(rotated, path).joinToString("\n") { p ->
            runCatching { Files.readString(p) }.getOrDefault("")
        }
        offset = runCatching { Files.size(path) }.getOrDefault(0L)
        partial = ""
        return parse(text.lines())
    }

    /** Records appended since the last read. */
    fun readNew(): List<UsageRecord> {
        val size = runCatching { Files.size(path) }.getOrDefault(0L)
        if (size < offset) {
            // Rotated: the old lines moved to `.1`; read the new file from its start.
            offset = 0
            partial = ""
        }
        if (size == offset) return emptyList()
        val bytes = ByteArray((size - offset).toInt())
        RandomAccessFile(path.toFile(), "r").use { file ->
            file.seek(offset)
            file.readFully(bytes)
        }
        offset = size
        val lines = (partial + String(bytes, StandardCharsets.UTF_8)).split('\n')
        // The last piece is a line still being written (or empty after a final newline).
        partial = lines.last()
        return parse(lines.dropLast(1))
    }

    private fun parse(lines: List<String>): List<UsageRecord> = lines.mapNotNull { line ->
        if (line.isBlank()) null else runCatching { gson.fromJson(line, UsageRecord::class.java) }.getOrNull()
    }
}

/** Calls and characters returned, per client and in total. */
data class Tally(val calls: Int = 0, val chars: Long = 0) {
    operator fun plus(r: UsageRecord) = Tally(calls + 1, chars + (r.chars ?: 0))
    val tokens: Long get() = chars / 4
}

/**
 * What the status bar shows about tool calls: today's and all-time counts per client, and the
 * most recent calls. Immutable, so the widget can read it from any thread.
 */
data class UsageSummary(
    /** Per day and client. */
    val byDay: Map<LocalDate, Map<String, Tally>> = emptyMap(),
    val total: Tally = Tally(),
    /** Newest first, at most [RECENT] calls. */
    val recent: List<UsageRecord> = emptyList(),
) {
    fun today(day: LocalDate = LocalDate.now()): Map<String, Tally> = byDay[day].orEmpty()

    fun todayTotal(day: LocalDate = LocalDate.now()): Tally =
        today(day).values.fold(Tally()) { a, b -> Tally(a.calls + b.calls, a.chars + b.chars) }

    /** This summary with more records (oldest first) added; connects and unreadable lines are skipped. */
    fun with(records: List<UsageRecord>, zone: ZoneId = ZoneId.systemDefault()): UsageSummary {
        val calls = records.filter { it.isCall }
        if (calls.isEmpty()) return this
        val days = byDay.mapValues { it.value.toMutableMap() }.toMutableMap()
        var total = this.total
        for (r in calls) {
            val day = r.day(zone) ?: continue
            val clients = days.getOrPut(day) { mutableMapOf() }
            val name = clientName(r.client)
            clients[name] = (clients[name] ?: Tally()) + r
            total += r
        }
        return UsageSummary(days, total, (calls.asReversed() + recent).take(RECENT))
    }

    companion object {
        const val RECENT = 5
    }
}
