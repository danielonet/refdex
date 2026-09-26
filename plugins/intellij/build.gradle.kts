import org.jetbrains.intellij.platform.gradle.TestFrameworkType
import org.jetbrains.kotlin.gradle.dsl.KotlinVersion

plugins {
    id("org.jetbrains.kotlin.jvm") version "2.4.20"
    id("org.jetbrains.intellij.platform") version "2.19.0"
}

group = "dev.refdex"
version = providers.gradleProperty("pluginVersion").get()

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    intellijPlatform {
        intellijIdea(providers.gradleProperty("platformVersion"))
        testFramework(TestFrameworkType.Platform)
    }
    // Not provided by the IntelliJ Platform (2025.3), so the plugin bundles it.
    implementation("com.google.code.gson:gson:2.14.0")
    testImplementation("junit:junit:4.13.2")
}

kotlin {
    jvmToolchain(21)
    compilerOptions {
        // Match the Kotlin stdlib bundled with the oldest supported IDE.
        apiVersion = KotlinVersion.KOTLIN_2_2
        languageVersion = KotlinVersion.KOTLIN_2_2
    }
}

intellijPlatform {
    pluginConfiguration {
        version = providers.gradleProperty("pluginVersion")
        ideaVersion {
            sinceBuild = providers.gradleProperty("pluginSinceBuild")
            untilBuild = provider { null }
        }
    }
    buildSearchableOptions = false
}

// ---- the daemon: built by npm in packages/server, staged into build/daemon, shipped as <plugin>/daemon ----
val repoRoot = layout.projectDirectory.dir("../..")
val daemonDir = layout.buildDirectory.dir("daemon")

val buildDaemon by tasks.registering(Exec::class) {
    description = "Builds the RefDex daemon bundle and this platform's single executable (npm run build:sea)."
    workingDir = repoRoot.asFile
    commandLine("npm", "run", "build:sea", "-w", "@refdex/server")
    inputs.dir(repoRoot.dir("packages/server/src"))
    inputs.dir(repoRoot.dir("packages/core/src"))
    outputs.file(repoRoot.file("packages/server/dist/refdex.cjs"))
    // -PskipDaemonBuild stages whatever packages/server/dist holds (the bundle alone runs with Node on PATH).
    val skip = providers.gradleProperty("skipDaemonBuild")
    onlyIf { !skip.isPresent }
}

val stageDaemon by tasks.registering(Exec::class) {
    description = "Collects refdex.cjs, the grammars and the executable into build/daemon."
    dependsOn(buildDaemon)
    workingDir = repoRoot.asFile
    commandLine("node", "packages/server/scripts/stage-daemon.mjs", daemonDir.get().asFile.absolutePath)
    inputs.dir(repoRoot.dir("packages/server/dist"))
    outputs.dir(daemonDir)
}

tasks {
    prepareSandbox {
        dependsOn(stageDaemon)
        from(daemonDir) {
            into(intellijPlatform.projectName.map { "$it/daemon" })
        }
    }
    test {
        // The daemon tests run the staged daemon against a fixture project.
        dependsOn(stageDaemon)
        systemProperty("refdex.daemonDir", daemonDir.get().asFile.absolutePath)
        systemProperty("refdex.fixture", repoRoot.dir("packages/core/test/fixtures/typescript").asFile.absolutePath)
    }
}
