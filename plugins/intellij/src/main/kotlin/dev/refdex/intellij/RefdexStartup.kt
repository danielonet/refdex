package dev.refdex.intellij

import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity

/** Starts the project's daemon when it opens; the daemon catches up on changes made meanwhile. */
class RefdexStartup : ProjectActivity {
    override suspend fun execute(project: Project) {
        if (project.basePath != null) RefdexProjectService.getInstance(project).start()
    }
}
