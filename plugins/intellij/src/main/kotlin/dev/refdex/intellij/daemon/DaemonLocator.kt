package dev.refdex.intellij.daemon

import java.io.File
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.nio.file.attribute.PosixFilePermissions

/** How to start the `refdex` CLI: an executable, or Node.js running the bundled `refdex.cjs`. */
data class RefdexLaunch(val command: List<String>) {
    /** The full command line for one CLI command, e.g. `serve --root …`. */
    fun with(vararg args: String): List<String> = command + args
    fun with(args: List<String>): List<String> = command + args
}

class DaemonNotFoundException(message: String) : Exception(message)

/**
 * Finds the daemon the plugin ships (see packages/server/scripts/stage-daemon.mjs), in order:
 *  1. the path set in RefDex's settings: an executable, or a `.cjs`/`.js` bundle to run with Node;
 *  2. the single executable for this platform, `<daemonDir>/<platform>-<arch>/refdex[.exe]`;
 *  3. Node.js 22.13+ on PATH running `<daemonDir>/refdex.cjs` (the grammars are in `wasm/` beside it).
 * Platforms and architectures use Node's names (linux, darwin, win32; x64, arm64), as the staging script does.
 *
 * The executable may arrive without its executable bit, or in a folder that is read-only or mounted
 * noexec. Then it is copied to `runDir` (a writable folder, such as the IDE's system directory) and
 * run from there.
 */
class DaemonLocator(
    private val daemonDir: Path,
    private val platform: String = currentPlatform(),
    private val arch: String = currentArch(),
    private val findOnPath: (String) -> Path? = ::findOnPath,
    private val runDir: Path? = null,
    private val makeExecutable: (Path) -> Unit = { it.toFile().setExecutable(true, false) },
) {
    fun locate(override: String? = null): RefdexLaunch {
        if (!override.isNullOrBlank()) {
            val path = Path.of(override)
            if (!Files.isRegularFile(path)) throw DaemonNotFoundException("the RefDex daemon set in settings does not exist: $override")
            return if (override.endsWith(".cjs") || override.endsWith(".js")) RefdexLaunch(listOf(node(), override)) else RefdexLaunch(listOf(override))
        }
        val exe = daemonDir.resolve("$platform-$arch").resolve(if (platform == "win32") "refdex.exe" else "refdex")
        if (Files.isRegularFile(exe)) return RefdexLaunch(listOf(runnable(exe).toString()))
        val bundle = daemonDir.resolve("refdex.cjs")
        if (!Files.isRegularFile(bundle)) throw DaemonNotFoundException("the plugin's daemon files are missing ($daemonDir); reinstall RefDex")
        return RefdexLaunch(listOf(node(), bundle.toString()))
    }

    /** The executable itself if it can run where it is, otherwise a runnable copy in [runDir]. */
    private fun runnable(exe: Path): Path {
        if (Files.isExecutable(exe)) return exe
        // Some installers and unzip tools drop the executable bit; put it back if the folder allows.
        runCatching { makeExecutable(exe) }
        if (Files.isExecutable(exe)) return exe
        val dir = runDir ?: throw DaemonNotFoundException("the RefDex daemon is not executable: $exe")
        // One copy per build of the daemon (size and time identify it), reused on later starts.
        val copy = dir.resolve("${Files.size(exe)}-${Files.getLastModifiedTime(exe).toMillis()}").resolve(exe.fileName)
        if (!Files.isExecutable(copy)) {
            Files.createDirectories(copy.parent)
            val partial = copy.resolveSibling("${exe.fileName}.partial")
            Files.copy(exe, partial, StandardCopyOption.REPLACE_EXISTING)
            if (platform != "win32") Files.setPosixFilePermissions(partial, PosixFilePermissions.fromString("rwxr-xr-x"))
            Files.move(partial, copy, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
        }
        if (!Files.isExecutable(copy)) throw DaemonNotFoundException("the RefDex daemon cannot be run from $exe or $copy")
        return copy
    }

    private fun node(): String = findOnPath(if (platform == "win32") "node.exe" else "node")?.toString()
        ?: throw DaemonNotFoundException(
            "RefDex has no built-in daemon for $platform-$arch yet. Install Node.js 22.13 or later (on PATH), " +
                "or set the daemon path in Settings | Tools | RefDex.",
        )

    companion object {
        fun currentPlatform(): String {
            val os = System.getProperty("os.name").lowercase()
            return when {
                os.startsWith("windows") -> "win32"
                os.startsWith("mac") -> "darwin"
                else -> "linux"
            }
        }

        fun currentArch(): String = when (val arch = System.getProperty("os.arch").lowercase()) {
            "amd64", "x86_64" -> "x64"
            "aarch64", "arm64" -> "arm64"
            else -> arch
        }

        fun findOnPath(exe: String): Path? = System.getenv("PATH").orEmpty().split(File.pathSeparator)
            .filter { it.isNotBlank() }
            .map { Path.of(it, exe) }
            .firstOrNull { Files.isRegularFile(it) && Files.isExecutable(it) }
    }
}
