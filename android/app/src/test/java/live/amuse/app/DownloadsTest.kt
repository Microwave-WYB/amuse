package live.amuse.app

import org.junit.Assert.*
import org.junit.Test

class DownloadsTest {
    @Test fun `the RFC 5987 name wins over the plain one, and non-ASCII names survive`() {
        assertEquals("报告 (1).pdf", Downloads.fileName("""attachment; filename="__ (1).pdf"; filename*=UTF-8''%E6%8A%A5%E5%91%8A%20%281%29.pdf"""))
        assertEquals("猫.png", Downloads.fileName("inline; filename*=UTF-8''%E7%8C%AB.png"))
        assertEquals("Ünï.docx", Downloads.fileName("attachment; FILENAME*=utf-8'de'%C3%9Cn%C3%AF.docx; filename=x.docx"))
        assertEquals("café.txt", Downloads.fileName("attachment; filename*=ISO-8859-1''caf%E9.txt"))
    }

    @Test fun `a plain filename is read quoted or bare`() {
        assertEquals("notes.txt", Downloads.fileName("attachment; filename=notes.txt"))
        assertEquals("a \"b\"; c.zip", Downloads.fileName("""attachment; filename="a \"b\"; c.zip""""))
        assertEquals("plain.txt", Downloads.fileName("""attachment; filename="plain.txt"; filename*=UTF-8''bad%ZZ"""))
    }

    @Test fun `no name, or one that is only folders, gives none`() {
        assertNull(Downloads.fileName(null))
        assertNull(Downloads.fileName("attachment"))
        assertNull(Downloads.fileName("attachment; filename=\"..\""))
        assertEquals("passwd", Downloads.fileName("attachment; filename*=UTF-8''..%2F..%2Fetc%2Fpasswd"))
        assertEquals("x.txt", Downloads.fileName("attachment; filename=\"a\\\\x.txt\""))
    }

    @Test fun `only a sent file's address has an id to report on`() {
        assertEquals("f-0b9c-41aa", Downloads.fileId("/files/f-0b9c-41aa"))
        for (path in listOf(null, "/files", "/files/", "/files/a/b", "/workspace/f-1", "/files/f-1%2F.."))
            assertNull(path, Downloads.fileId(path))
    }

    @Test fun `a file is saved as the server's type, or by its name when the server said only bytes`() {
        assertEquals("application/pdf", Downloads.type("application/pdf; charset=binary", "text/plain"))
        assertEquals("text/html", Downloads.type("application/octet-stream", "text/html"))
        assertEquals("application/octet-stream", Downloads.type(null, null))
    }

    @Test fun `a card is told how far its file got, and why it failed`() {
        assertEquals("""{"id":"f-1","state":"progress","received":5,"total":10}""", Downloads.report("f-1", "progress", 5, 10))
        assertEquals("""{"id":"f-1","state":"failed","reason":"offline"}""", Downloads.report("f-1", "failed", reason = "offline"))
        assertEquals("""{"id":"f-\"1\\","state":"saved"}""", Downloads.report("f-\"1\\", "saved"))
    }
}
