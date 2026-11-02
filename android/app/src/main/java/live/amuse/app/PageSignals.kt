package live.amuse.app

/** What the app tells the page it shows, as events on its window (web/src/return.ts listens for them). */
object PageSignals {
    /** The activity is in front again: the page checks its connection to the server, and catches up. */
    const val FOREGROUND = "amuse:foreground"
    const val FOREGROUND_SCRIPT = "window.dispatchEvent(new Event('$FOREGROUND'))"
}
