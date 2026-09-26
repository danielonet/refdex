package dev.refdex.intellij.daemon

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.nio.file.Path
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit

/** Runs the daemon staged by the build (build/daemon) on a copy of the TypeScript fixture. */
class DaemonClientTest {
    @get:Rule val tmp = TemporaryFolder()

    private lateinit var root: Path
    private lateinit var db: Path
    private lateinit var launch: RefdexLaunch
    private val clients = mutableListOf<DaemonClient>()

    @Before
    fun setUp() {
        root = tmp.newFolder("project").toPath()
        Path.of(System.getProperty("refdex.fixture")).toFile().copyRecursively(root.toFile())
        db = tmp.root.toPath().resolve("index/index.db")
        launch = DaemonLocator(Path.of(System.getProperty("refdex.daemonDir"))).locate()
    }

    @After
    fun tearDown() = clients.forEach { it.stop() }

    private fun client(options: DaemonOptions = DaemonOptions()) =
        DaemonClient(launch.with(options.serveArgs(root.toString(), db.toString()))).also { clients += it }

    @Test
    fun `indexes the project and reports stats and events`() {
        val client = client()
        val events = CopyOnWriteArrayList<DaemonEvent>()
        client.onEvent { events += it }
        assertEquals(0, client.stats().get(30, TimeUnit.SECONDS).files)

        val summary = client.reindex().get(60, TimeUnit.SECONDS)
        assertTrue("indexed ${summary.indexed}", summary.indexed > 0)
        val stats = client.stats().get(30, TimeUnit.SECONDS)
        assertEquals(summary.files, stats.files)
        assertTrue(stats.symbols > 0 && stats.codeChars > 0)
        assertTrue(events.any { it is DaemonEvent.Indexing } && events.any { it is DaemonEvent.Indexed })

        val info = client.info().get(30, TimeUnit.SECONDS)
        assertEquals(root.toString(), info.root)
        assertTrue("watching after the first index", info.watching)
    }

    @Test
    fun `restarts with the index kept, and fails requests of a stopped daemon`() {
        val client = client(DaemonOptions(watch = false))
        client.reindex().get(60, TimeUnit.SECONDS)
        client.restart()
        assertTrue(client.stats().get(30, TimeUnit.SECONDS).files > 0)
        assertEquals(false, client.info().get(30, TimeUnit.SECONDS).watching)
        client.stop()
        assertTrue(!client.running)
    }

    @Test
    fun `a daemon that exits fails its requests and says why`() {
        // Without --root the daemon exits at once. Its requests fail instead of hanging (with a
        // broken pipe if it is gone before the write).
        val broken = DaemonClient(launch.with("serve")).also { clients += it }
        val exited = CopyOnWriteArrayList<DaemonEvent>()
        broken.onEvent { exited += it }
        val failure = runCatching { broken.stats().get(30, TimeUnit.SECONDS) }.exceptionOrNull()
        assertTrue("$failure", failure is ExecutionException)
        val deadline = System.currentTimeMillis() + 5_000
        while (exited.isEmpty() && System.currentTimeMillis() < deadline) Thread.sleep(50)
        val event = exited.filterIsInstance<DaemonEvent.Exited>().single()
        assertTrue(event.lastOutput, event.lastOutput.contains("--root"))
    }
}
