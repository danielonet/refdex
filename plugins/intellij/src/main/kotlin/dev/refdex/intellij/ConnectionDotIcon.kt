package dev.refdex.intellij

import com.intellij.ui.JBColor
import com.intellij.util.ui.JBUI
import java.awt.BasicStroke
import java.awt.Color
import java.awt.Component
import java.awt.Graphics
import java.awt.Graphics2D
import java.awt.RenderingHints
import java.awt.geom.Ellipse2D
import java.awt.geom.Path2D
import javax.swing.Icon

/**
 * The status bar's connection dot: a green circle with a white check when RefDex is connected to an
 * AI client, a plain red circle when it isn't. Drawn rather than loaded, so it stays crisp at every
 * scale.
 */
class ConnectionDotIcon private constructor(private val connected: Boolean) : Icon {
    override fun getIconWidth() = JBUI.scale(SIZE)

    override fun getIconHeight() = JBUI.scale(SIZE)

    override fun paintIcon(c: Component?, g: Graphics, x: Int, y: Int) {
        val g2 = g.create() as Graphics2D
        try {
            g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
            g2.setRenderingHint(RenderingHints.KEY_STROKE_CONTROL, RenderingHints.VALUE_STROKE_PURE)
            val s = iconWidth.toDouble()
            g2.color = if (connected) GREEN else RED
            g2.fill(Ellipse2D.Double(x.toDouble(), y.toDouble(), s, s))
            if (connected) {
                g2.color = Color.WHITE
                g2.stroke = BasicStroke(JBUI.scale(1.4f), BasicStroke.CAP_ROUND, BasicStroke.JOIN_ROUND)
                g2.draw(Path2D.Double().apply {
                    moveTo(x + s * 0.27, y + s * 0.52)
                    lineTo(x + s * 0.44, y + s * 0.69)
                    lineTo(x + s * 0.74, y + s * 0.34)
                })
            }
        } finally {
            g2.dispose()
        }
    }

    companion object {
        private const val SIZE = 10
        private val GREEN = JBColor(Color(0x3D9A50), Color(0x57A64A))
        private val RED = JBColor(Color(0xDB3B3B), Color(0xE05555))

        val CONNECTED: Icon = ConnectionDotIcon(true)
        val NOT_CONNECTED: Icon = ConnectionDotIcon(false)
    }
}
