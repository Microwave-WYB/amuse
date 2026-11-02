package live.amuse.app

import java.nio.charset.Charset

/** Pure parts of saving a download, shared by the activity and JVM tests. */
object Downloads {
    /**
     * The file name a Content-Disposition header gives: RFC 5987 `filename*` (what Amuse sends, and what
     * URLUtil.guessFileName does not read) before a plain `filename`. Null when it gives none.
     */
    fun fileName(disposition: String?): String? {
        if (disposition == null) return null
        val params = Regex("""(?i);\s*(filename\*?)\s*=\s*("(?:[^"\\]|\\.)*"|[^;]*)""").findAll(disposition)
            .associate { it.groupValues[1].lowercase() to it.groupValues[2].trim() }
        params["filename*"]?.let { extended(it) }?.let { return clean(it) }
        val plain = params["filename"]?.let { if (it.startsWith('"')) it.drop(1).dropLast(1).replace(Regex("""\\(.)"""), "$1") else it }
        return plain?.let(::clean)
    }

    /** `charset'lang'percent-encoded`, decoded; null when it is not one. */
    private fun extended(value: String): String? {
        val parts = value.trim('"').split('\'', limit = 3)
        if (parts.size != 3) return null
        val charset = runCatching { Charset.forName(parts[0]) }.getOrNull() ?: return null
        val bytes = java.io.ByteArrayOutputStream()
        var i = 0
        val text = parts[2]
        while (i < text.length) {
            val c = text[i]
            if (c == '%') {
                if (i + 2 >= text.length) return null
                bytes.write(text.substring(i + 1, i + 3).toIntOrNull(16) ?: return null); i += 3
            } else { bytes.write(c.code); i++ }
        }
        return String(bytes.toByteArray(), charset)
    }

    /** A name as one file's name: no folders, no control characters; null when nothing is left. */
    fun clean(name: String): String? =
        name.substringAfterLast('/').substringAfterLast('\\').replace(Regex("[\\x00-\\x1f\\x7f]"), "").trim()
            .takeUnless { it.isEmpty() || it == "." || it == ".." }

    /** The id of a sent file from its address (`/files/<id>`), to report on its card; null for other downloads. */
    fun fileId(path: String?): String? =
        path?.let { Regex("^/files/([A-Za-z0-9_-]+)$").find(it)?.groupValues?.get(1) }

    /** The type to save a file as: the server's, unless it only said "bytes"; then the one its name implies. */
    fun type(served: String?, byName: String?): String {
        val type = served?.substringBefore(';')?.trim()?.lowercase()
        return if (!type.isNullOrEmpty() && type != "application/octet-stream") type else byName ?: "application/octet-stream"
    }

    /** An `amuse-download` event's detail for the page (see web/src/download.ts), as JSON. */
    fun report(id: String, state: String, received: Long? = null, total: Long? = null, reason: String? = null): String {
        fun quote(text: String) = "\"" + text.replace("\\", "\\\\").replace("\"", "\\\"") + "\""
        return buildString {
            append("{\"id\":").append(quote(id)).append(",\"state\":").append(quote(state))
            if (received != null) append(",\"received\":").append(received)
            if (total != null) append(",\"total\":").append(total)
            if (reason != null) append(",\"reason\":").append(quote(reason))
            append('}')
        }
    }
}
