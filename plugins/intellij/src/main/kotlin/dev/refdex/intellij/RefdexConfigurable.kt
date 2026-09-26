package dev.refdex.intellij

import com.intellij.openapi.fileChooser.FileChooserDescriptorFactory
import com.intellij.openapi.options.BoundConfigurable
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogPanel
import com.intellij.ui.dsl.builder.AlignX
import com.intellij.ui.dsl.builder.bindIntText
import com.intellij.ui.dsl.builder.bindItem
import com.intellij.ui.dsl.builder.bindSelected
import com.intellij.ui.dsl.builder.bindText
import com.intellij.ui.dsl.builder.panel
import com.intellij.ui.dsl.builder.toNullableProperty
import com.intellij.ui.dsl.listCellRenderer.textListCellRenderer

/** Settings | Tools | RefDex. */
class RefdexConfigurable(private val project: Project) : BoundConfigurable("RefDex") {
    private val settings = RefdexSettings.getInstance(project)

    // Edited copies, written back in apply() so a change can tell what it touched.
    private var include = ""
    private var exclude = ""
    private val languages = LANGUAGES.keys.associateWith { false }.toMutableMap()
    private var watch = true
    private var aiTools = AiToolsMode.AUTO
    private var minTokens = RefdexSettings.DEFAULT_MIN_TOKENS
    private var daemonPath = ""

    override fun createPanel(): DialogPanel {
        load()
        return panel {
            group("Indexing") {
                row("Include:") {
                    textField().bindText(::include).align(AlignX.FILL)
                        .comment("Glob patterns of files to index, comma-separated. Empty means every supported file.")
                }
                row("Exclude:") {
                    textField().bindText(::exclude).align(AlignX.FILL)
                        .comment("Glob patterns to skip, on top of .gitignore and the built-in excludes (node_modules, build output).")
                }
                row("Languages:") {
                    for ((id, label) in LANGUAGES) {
                        checkBox(label).bindSelected({ languages[id]!! }, { languages[id] = it })
                    }
                }.rowComment("None selected means all languages.")
                row {
                    checkBox("Keep the index up to date as files change").bindSelected(::watch)
                }
            }
            group("AI Clients") {
                row("Offer RefDex's tools:") {
                    comboBox(AiToolsMode.entries.toList(), textListCellRenderer { it?.label.orEmpty() }).bindItem(::aiTools.toNullableProperty())
                }.rowComment(
                    "The tool definitions cost about 1,200 tokens per request, so on a small codebase, where reading files is cheap, they cost more than they save.",
                )
                row("Threshold (tokens of code):") {
                    intTextField(0..Int.MAX_VALUE).bindIntText(::minTokens)
                }
            }
            group("Advanced") {
                row("Daemon:") {
                    textFieldWithBrowseButton(FileChooserDescriptorFactory.createSingleFileDescriptor().withTitle("RefDex Daemon"), project)
                        .bindText(::daemonPath).align(AlignX.FILL)
                        .comment("A refdex executable or refdex.cjs bundle to use instead of the built-in daemon. Empty uses the built-in one.")
                }
            }
        }
    }

    private fun load() {
        val s = settings.state
        include = s.include.joinToString(", ")
        exclude = s.exclude.joinToString(", ")
        languages.keys.forEach { languages[it] = it in s.languages }
        watch = s.watch
        aiTools = settings.aiToolsMode
        minTokens = s.aiToolsMinTokens
        daemonPath = s.daemonPath.orEmpty()
    }

    override fun reset() {
        load()
        super.reset()
    }

    override fun apply() {
        super.apply()
        val s = settings.state
        val before = settings.daemonOptions() to s.daemonPath.orEmpty()
        s.include = splitGlobs(include)
        s.exclude = splitGlobs(exclude)
        s.languages = languages.filterValues { it }.keys.toMutableList()
        s.watch = watch
        s.aiTools = aiTools.id
        s.aiToolsMinTokens = minTokens
        s.daemonPath = daemonPath.trim().ifEmpty { null }
        val daemonChanged = before != settings.daemonOptions() to s.daemonPath.orEmpty()
        RefdexProjectService.getInstance(project).settingsChanged(daemonChanged)
    }

    private fun splitGlobs(text: String) = text.split(',').map { it.trim() }.filter { it.isNotEmpty() }.toMutableList()

    companion object {
        private val LANGUAGES = linkedMapOf("python" to "Python", "typescript" to "TypeScript", "java" to "Java", "csharp" to "C#")
    }
}
