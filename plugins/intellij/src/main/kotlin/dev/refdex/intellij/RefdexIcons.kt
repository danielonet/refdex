package dev.refdex.intellij

import com.intellij.openapi.util.IconLoader

/** The RefDex glyph at 16 px; IconLoader picks refdex_dark.svg in dark themes. */
object RefdexIcons {
    @JvmField val Logo = IconLoader.getIcon("/icons/refdex.svg", RefdexIcons::class.java)
}
