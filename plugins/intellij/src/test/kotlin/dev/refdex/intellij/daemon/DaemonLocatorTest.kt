package dev.refdex.intellij.daemon

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.nio.file.Files
import java.nio.file.Path

class DaemonLocatorTest {
    @get:Rule val tmp = TemporaryFolder()

    private val node = Path.of("/usr/bin/node")

    private fun daemonDir(exeFor: String? = null): Path {
        val dir = tmp.newFolder("daemon").toPath()
        Files.writeString(dir.resolve("refdex.cjs"), "")
        if (exeFor != null) {
            Files.createDirectories(dir.resolve(exeFor))
            Files.writeString(dir.resolve(exeFor).resolve(if (exeFor.startsWith("win32")) "refdex.exe" else "refdex"), "")
        }
        return dir
    }

    @Test
    fun `prefers this platform's executable`() {
        val dir = daemonDir("linux-x64")
        val launch = DaemonLocator(dir, "linux", "x64") { node }.locate()
        assertEquals(listOf(dir.resolve("linux-x64/refdex").toString()), launch.command)
    }

    @Test
    fun `falls back to Node on PATH running the bundle`() {
        val dir = daemonDir("linux-x64")
        val launch = DaemonLocator(dir, "darwin", "arm64") { node }.locate()
        assertEquals(listOf(node.toString(), dir.resolve("refdex.cjs").toString()), launch.command)
        assertEquals(listOf(node.toString(), dir.resolve("refdex.cjs").toString(), "serve"), launch.with("serve"))
    }

    @Test
    fun `explains what to install without an executable or Node`() {
        val e = assertThrows(DaemonNotFoundException::class.java) { DaemonLocator(daemonDir(), "win32", "arm64") { null }.locate() }
        assertTrue(e.message!!, e.message!!.contains("win32-arm64") && e.message!!.contains("Node.js"))
    }

    @Test
    fun `uses the daemon set in settings`() {
        val dir = daemonDir("linux-x64")
        val exe = tmp.newFile("my-refdex").toPath()
        val bundle = tmp.newFile("refdex.cjs").toPath()
        val locator = DaemonLocator(dir, "linux", "x64") { node }
        assertEquals(listOf(exe.toString()), locator.locate(exe.toString()).command)
        assertEquals(listOf(node.toString(), bundle.toString()), locator.locate(bundle.toString()).command)
        assertThrows(DaemonNotFoundException::class.java) { locator.locate("/nowhere/refdex") }
    }
}
