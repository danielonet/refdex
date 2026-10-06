package dev.refdex.intellij

import java.awt.Color
import java.awt.image.BufferedImage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ConnectionIndicatorTest {
    @Test
    fun `says which clients are connected, or how to connect one`() {
        assertEquals("Connected to Claude Code, Junie", RefdexStatusWidget.connectionLine(listOf("Claude Code", "Junie")))
        assertEquals("Not connected to an AI client: click, then Connect AI Client…", RefdexStatusWidget.connectionLine(emptyList()))
    }

    /** The colour at a point of the dot, drawn on white. */
    private fun pixel(icon: javax.swing.Icon, fx: Double, fy: Double): Color {
        val image = BufferedImage(icon.iconWidth, icon.iconHeight, BufferedImage.TYPE_INT_RGB)
        val g = image.createGraphics()
        g.color = Color.WHITE
        g.fillRect(0, 0, image.width, image.height)
        icon.paintIcon(null, g, 0, 0)
        g.dispose()
        return Color(image.getRGB((image.width * fx).toInt(), (image.height * fy).toInt()))
    }

    @Test
    fun `the dot is green with a white check when connected, plain red when not`() {
        val green = pixel(ConnectionDotIcon.CONNECTED, 0.5, 0.2)
        assertTrue("green fill: $green", green.green > green.red && green.green > green.blue)
        val check = pixel(ConnectionDotIcon.CONNECTED, 0.44, 0.66)
        assertTrue("white check: $check", check.red > 200 && check.green > 200 && check.blue > 200)
        val red = pixel(ConnectionDotIcon.NOT_CONNECTED, 0.5, 0.5)
        assertTrue("red fill: $red", red.red > red.green && red.red > red.blue)
        assertEquals(ConnectionDotIcon.CONNECTED.iconWidth, ConnectionDotIcon.NOT_CONNECTED.iconWidth)
    }
}
