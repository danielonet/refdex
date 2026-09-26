package dev.refdex.intellij.daemon

/** The daemon's answers (packages/core/src/db.ts, indexer.ts), read with Gson. */
data class IndexStats(
    val files: Int,
    val symbols: Int,
    val imports: Int,
    val resolvedImports: Int,
    val edges: Int,
    val resolvedEdges: Int,
    /** Characters of indexed source code; about 4 per token. */
    val codeChars: Long,
    val byLanguage: List<LanguageStats>?,
    val indexedAt: String?,
)

data class LanguageStats(val language: String, val files: Int, val symbols: Int)

data class IndexSummary(
    val indexed: Int,
    val unchanged: Int,
    val removed: Int,
    val failed: List<FailedFile>?,
    val files: Int,
    val symbols: Int,
    val ms: Long,
)

data class FailedFile(val path: String, val error: String)

data class DaemonInfo(
    val pid: Long,
    val root: String,
    val dbPath: String,
    val dbBytes: Long,
    val watching: Boolean,
    val node: String,
)

/** What `refdex serve` indexes and whether it watches files; changing any of them restarts it. */
data class DaemonOptions(
    val exclude: List<String> = emptyList(),
    val include: List<String> = emptyList(),
    val languages: List<String> = emptyList(),
    val watch: Boolean = true,
) {
    fun serveArgs(root: String, dbPath: String): List<String> = buildList {
        addAll(listOf("serve", "--root", root, "--db", dbPath))
        exclude.forEach { addAll(listOf("--exclude", it)) }
        include.forEach { addAll(listOf("--include", it)) }
        languages.forEach { addAll(listOf("--language", it)) }
        if (!watch) add("--no-watch")
    }
}

sealed interface DaemonEvent {
    data class Indexing(val full: Boolean, val rebuild: Boolean, val paths: Int) : DaemonEvent
    data class Indexed(val summary: IndexSummary, val stats: IndexStats) : DaemonEvent
    data class Error(val message: String) : DaemonEvent
    /** The daemon process ended; `lastOutput` is the end of its stderr, for the error message. */
    data class Exited(val code: Int, val lastOutput: String) : DaemonEvent
}
