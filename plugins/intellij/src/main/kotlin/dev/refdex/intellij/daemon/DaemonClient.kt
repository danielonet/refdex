package dev.refdex.intellij.daemon

import com.google.gson.Gson
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.nio.charset.StandardCharsets
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * Talks to `refdex serve` over JSON lines on stdio (packages/server/src/serve.ts): requests
 * `{"id", "method", "params"}` on stdin, answers `{"id", "result" | "error"}` and events
 * `{"event": "indexing" | "indexed" | "error"}` on stdout. The daemon exits when stdin closes.
 * Free of IntelliJ APIs, so it is tested against the real daemon without an IDE.
 */
class DaemonClient(
    private val command: List<String>,
    private val log: (String) -> Unit = {},
) : AutoCloseable {
    private val gson = Gson()
    private val nextId = AtomicInteger(1)
    private val pending = ConcurrentHashMap<Int, Pending>()
    private val listeners = CopyOnWriteArrayList<(DaemonEvent) -> Unit>()
    private var process: Process? = null
    private var stdin: OutputStreamWriter? = null

    private class Pending(val method: String, val started: Long, val future: CompletableFuture<JsonElement>)

    val running: Boolean
        @Synchronized get() = process?.isAlive == true

    fun onEvent(listener: (DaemonEvent) -> Unit) {
        listeners += listener
    }

    @Synchronized
    fun start() {
        if (running) return
        log("starting daemon: ${command.joinToString(" ")}")
        val proc = ProcessBuilder(command).start()
        process = proc
        stdin = OutputStreamWriter(proc.outputStream, StandardCharsets.UTF_8)
        val stderrTail = ArrayDeque<String>()
        thread("RefDex daemon stderr") {
            proc.errorStream.bufferedReader(StandardCharsets.UTF_8).forEachLine { line ->
                log(line)
                synchronized(stderrTail) {
                    stderrTail.addLast(line)
                    if (stderrTail.size > 20) stderrTail.removeFirst()
                }
            }
        }
        thread("RefDex daemon stdout") {
            BufferedReader(InputStreamReader(proc.inputStream, StandardCharsets.UTF_8)).forEachLine(::onLine)
            val code = proc.waitFor()
            val stopped = synchronized(this) {
                (process !== proc).also { if (!it) process = null }
            }
            log("daemon exited ($code)")
            // After a stop or restart, `stop` already failed this process's requests, and those
            // pending now belong to the new process. An exit we did not ask for is worth showing.
            if (!stopped) {
                failPending("RefDex daemon exited")
                emit(DaemonEvent.Exited(code, synchronized(stderrTail) { stderrTail.joinToString("\n") }))
            }
        }
    }

    /** Restarts with a new command line (settings changed). The daemon then catches up on its own. */
    fun restart(): Unit = synchronized(this) {
        stop()
        start()
    }

    fun reindex(full: Boolean = true): CompletableFuture<IndexSummary> = request("reindex", JsonObject().apply { addProperty("full", full) })

    /** Drops the index and builds it again from scratch. */
    fun rebuild(): CompletableFuture<IndexSummary> = request("rebuild")

    fun stats(): CompletableFuture<IndexStats> = request("stats")

    fun info(): CompletableFuture<DaemonInfo> = request("info")

    /** Flushes the write-ahead log into index.db so other tools see the whole index. */
    fun checkpoint(): CompletableFuture<Unit> = request<JsonElement>("checkpoint").thenApply { }

    private inline fun <reified T> request(method: String, params: JsonObject? = null): CompletableFuture<T> =
        send(method, params).thenApply { gson.fromJson(it, T::class.java) }

    private fun send(method: String, params: JsonObject?): CompletableFuture<JsonElement> {
        val future = CompletableFuture<JsonElement>()
        synchronized(this) {
            try {
                start()
                val id = nextId.getAndIncrement()
                pending[id] = Pending(method, System.currentTimeMillis(), future)
                val msg = JsonObject().apply {
                    addProperty("id", id)
                    addProperty("method", method)
                    if (params != null) add("params", params)
                }
                stdin!!.apply {
                    write(gson.toJson(msg))
                    write("\n")
                    flush()
                }
            } catch (e: Exception) {
                future.completeExceptionally(e)
            }
        }
        return future
    }

    private fun onLine(line: String) {
        val msg = try {
            JsonParser.parseString(line).asJsonObject
        } catch (_: Exception) {
            log(line)
            return
        }
        val id = msg.get("id")
        if (id != null && !id.isJsonNull) {
            val p = pending.remove(id.asInt) ?: return
            val took = "${System.currentTimeMillis() - p.started} ms"
            val error = msg.get("error")
            if (error != null && !error.isJsonNull) {
                log("← daemon ${p.method} failed after $took: ${error.asString}")
                p.future.completeExceptionally(DaemonException(error.asString))
            } else {
                log("← daemon ${p.method} $took")
                p.future.complete(msg.get("result"))
            }
            return
        }
        val event = when (msg.get("event")?.asString) {
            "indexing" -> DaemonEvent.Indexing(msg.bool("full"), msg.bool("rebuild"), msg.get("paths")?.asInt ?: 0)
            "indexed" -> DaemonEvent.Indexed(
                gson.fromJson(msg.get("summary"), IndexSummary::class.java),
                gson.fromJson(msg.get("stats"), IndexStats::class.java),
            )
            "error" -> DaemonEvent.Error(msg.get("message")?.asString ?: "unknown error")
            else -> return
        }
        when (event) {
            is DaemonEvent.Indexing -> log("daemon: indexing ${if (event.rebuild) "from scratch" else if (event.full) "the project" else "${event.paths} changed path(s)"}")
            is DaemonEvent.Indexed -> event.summary.let {
                log("daemon: indexed ${it.indexed} files (${it.unchanged} unchanged, ${it.removed} removed, ${it.failed.orEmpty().size} failed) in ${it.ms} ms")
            }
            is DaemonEvent.Error -> log("daemon error: ${event.message}")
            is DaemonEvent.Exited -> {}
        }
        emit(event)
    }

    private fun emit(event: DaemonEvent) = listeners.forEach { listener ->
        try {
            listener(event)
        } catch (e: Exception) {
            log("RefDex event listener failed: $e")
        }
    }

    private fun failPending(reason: String) {
        val all = pending.values.toList()
        pending.clear()
        all.forEach { it.future.completeExceptionally(DaemonException(reason)) }
    }

    /** Closes stdin, which ends the daemon; kills it if it has not exited within two seconds. */
    @Synchronized
    fun stop() {
        val proc = process ?: return
        process = null
        try {
            stdin?.close()
        } catch (_: Exception) {
        }
        if (!proc.waitFor(2, TimeUnit.SECONDS)) proc.destroyForcibly()
        failPending("RefDex daemon restarted")
    }

    override fun close() = stop()

    private fun JsonObject.bool(name: String) = get(name)?.takeIf { it.isJsonPrimitive }?.asBoolean ?: false

    private fun thread(name: String, body: () -> Unit) = Thread(body, name).apply {
        isDaemon = true
        start()
    }
}

class DaemonException(message: String) : Exception(message)
