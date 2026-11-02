package live.amuse.app

import android.Manifest
import android.app.KeyguardManager
import android.content.ContentValues
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Color
import android.hardware.biometrics.BiometricManager
import android.hardware.biometrics.BiometricPrompt
import android.net.ConnectivityManager
import android.net.Network
import android.net.Uri
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.os.CancellationSignal
import android.os.Environment
import android.provider.MediaStore
import android.webkit.*
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.*
import java.net.URL
import javax.net.ssl.HttpsURLConnection
import live.amuse.app.ui.AmuseApp
import live.amuse.app.ui.ShellState
import live.amuse.app.ui.theme.AmuseTheme

/** The server owns authentication and chat state; this activity is a WebView client. */
class MainActivity : ComponentActivity() {
    private lateinit var vault: SessionVault
    private val preferences by lazy { getSharedPreferences("amuse_settings", MODE_PRIVATE) }
    private val cookies by lazy { CookieManager.getInstance() }
    private var state by mutableStateOf(ShellState())
    private var webView: WebView? = null
    private var foreground = false
    private var captureJob: Job? = null
    private var cancellation: CancellationSignal? = null
    private var generation = 0
    private var pendingUnlock: Pair<Int, String?>? = null
    private var lastCookie: String? = null
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var pickedFiles: Array<Uri>? = null
    private var pickerReturned = false
    private var pausedCookie: String? = null
    private var microphoneRequest: PermissionRequest? = null
    private var permissionDialogInFlight = false
    private var microphoneResult: Boolean? = null
    private val savedFiles by lazy { getSharedPreferences("amuse_downloads", MODE_PRIVATE) }
    private val downloading = mutableSetOf<String>()
    /** A new default network (Wi-Fi to mobile data, say) while in front: the page checks its socket, which may have died with the old one. */
    private val networkChanges = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) { runOnUiThread { if (foreground) tellPageInFront() } }
    }

    private val documentPicker = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        pickedFiles = pickedUris(result.resultCode, result.data)
        pickerReturned = true
        if (state.pickerSuspended) resumePicker() else deliverFiles()
    }
    private val recordAudio = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        permissionDialogInFlight = false
        if (foreground) finishMicrophonePermission(granted) else microphoneResult = granted
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        vault = SessionVault(this)
        getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(networkChanges)
        val savedServer = preferences.getString("server", null)?.let { runCatching { ServerAddress.parse(it) }.getOrNull() }
        state = state.copy(server = savedServer ?: ServerAddress.parse(ServerAddress.EXAMPLE),
            configured = savedServer != null, settingsVisible = savedServer == null,
            deviceSecure = getSystemService(KeyguardManager::class.java).isDeviceSecure,
            useDeviceUnlock = preferences.getBoolean("device_unlock", false),
            reusableSessionSupported = Build.VERSION.SDK_INT >= 30,
            // until the page says which it shows: the last one it showed, else the system's
            darkTheme = if (preferences.contains("dark_theme")) preferences.getBoolean("dark_theme", false) else systemDark())
        state = state.copy(rememberedSession = vault.hasSession(state.server))
        updateSystemBars()
        // In optional lock mode the reusable copy lives only in the authenticated vault.
        if (state.useDeviceUnlock) cookies.removeAllCookies { cookies.flush(); cookiesReady() }
        else cookiesReady()
        setContent {
            AmuseTheme(state.darkTheme) {
                AmuseApp(state, ::createWebView, ::releaseWebView, ::authenticate, ::useServerLogin,
                    onLock = { if (state.useDeviceUnlock) lockSession() else forgetSession() },
                    onSettings = {
                        if (state.pickerSuspended) lockSession() else captureSession()
                        state = state.copy(settingsVisible = true)
                    },
                    onCloseSettings = { if (state.configured) { state = state.copy(settingsVisible = false); openSavedSession() } },
                    onSaveSettings = ::saveSettings, onForget = ::forgetSession,
                    onRetry = { state = state.copy(connectionError = null, loading = true); webView?.loadUrl(state.server.home) },
                    onBack = { webView?.let { if (it.canGoBack()) it.goBack() } },
                    onMicrophoneAllow = ::requestMicrophonePermission,
                    onMicrophoneDeny = ::denyMicrophonePermission)
            }
        }
    }

    private fun cookiesReady() { state = state.copy(cookiesReady = true); openSavedSession() }

    override fun onResume() {
        super.onResume()
        foreground = true
        val secure = getSystemService(KeyguardManager::class.java).isDeviceSecure
        if (!secure && state.deviceSecure) vault.clear()
        state = state.copy(deviceSecure = secure, rememberedSession = vault.hasSession(state.server))
        pendingUnlock?.let { pendingUnlock = null; finishUnlock(it.second, it.first) }
        microphoneResult?.let { microphoneResult = null; finishMicrophonePermission(it) }
        webView?.onResume()
        tellPageInFront()
        if (state.pickerSuspended) resumePicker()
        openSavedSession()
    }

    /**
     * The page cannot always tell it is in front again (the WebView does not reliably say so), and its socket may have
     * died in the background without a close: say so, and the page checks the connection and fetches what it missed.
     */
    private fun tellPageInFront() { webView?.evaluateJavascript(PageSignals.FOREGROUND_SCRIPT, null) }

    override fun onPause() {
        captureSession()
        when {
            fileCallback != null && state.unlocked -> suspendForPicker()
            permissionDialogInFlight -> webView?.onPause()
            state.useDeviceUnlock && !state.pickerSuspended -> lockSession(cancelPrompt = false)
            else -> { denyMicrophonePermission(); webView?.onPause(); cookies.flush() }
        }
        // Keep a live system-authentication handoff, but invalidate ordinary
        // asynchronous cookie callbacks when leaving the page. They must not
        // unlock a new foreground visit using the previous visit's attempt.
        if (!permissionDialogInFlight && cancellation == null) cancelAuthentication()
        foreground = false
        super.onPause()
    }

    override fun onStop() {
        // A runtime permission dialog does not stop the host activity. A real
        // background transition must never leave a capture request pending.
        denyMicrophonePermission()
        if (state.useDeviceUnlock && !state.pickerSuspended) lockSession(cancelPrompt = false)
        super.onStop()
    }

    override fun onDestroy() {
        getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(networkChanges)
        cancelAuthentication()
        denyMicrophonePermission()
        releaseWebView(webView)
        fileCallback?.onReceiveValue(null)
        super.onDestroy()
    }

    private fun cancelAuthentication() {
        generation++
        cancellation?.cancel(); cancellation = null; pendingUnlock = null
        state = state.copy(authenticating = false)
    }

    private fun canRemember() = state.useDeviceUnlock && state.deviceSecure && Build.VERSION.SDK_INT >= 30

    private fun authenticate() {
        if (!state.cookiesReady || state.authenticating) return
        if (!state.deviceSecure) { state = state.copy(notice = "Set up a secure screen lock, or sign in to the server."); return }
        cancelAuthentication()
        val attempt = generation
        val server = state.server
        val pending = if (canRemember() && vault.hasSession(server)) runCatching { vault.prepare(server) }.getOrElse {
            vault.clear(); state = state.copy(rememberedSession = false); null
        } else null
        val builder = BiometricPrompt.Builder(this).setTitle("Unlock Amuse")
            .setSubtitle("Use your fingerprint or device screen lock").setConfirmationRequired(false)
        if (Build.VERSION.SDK_INT >= 30) {
            val allowed = BiometricManager.Authenticators.BIOMETRIC_STRONG or BiometricManager.Authenticators.DEVICE_CREDENTIAL
            if (getSystemService(BiometricManager::class.java).canAuthenticate(allowed) != BiometricManager.BIOMETRIC_SUCCESS) {
                state = state.copy(notice = "Device unlock is unavailable. You can sign in to the server instead."); return
            }
            builder.setAllowedAuthenticators(allowed)
        } else {
            @Suppress("DEPRECATION") builder.setDeviceCredentialAllowed(true)
        }
        val signal = CancellationSignal()
        cancellation = signal
        state = state.copy(authenticating = true)
        val callback = object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                if (attempt != generation) return
                cancellation = null
                val cookie = runCatching {
                    if (pending == null) pausedCookie else vault.open(pending, requireNotNull(result.cryptoObject?.cipher), server)
                }.getOrElse {
                    vault.clear(); state = state.copy(authenticating = false, rememberedSession = false,
                        notice = "Saved sign-in could not be unlocked. Sign in to the server again."); return
                }
                if (foreground) finishUnlock(cookie, attempt) else pendingUnlock = attempt to cookie
            }
            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                if (attempt == generation) { cancellation = null; state = state.copy(authenticating = false, notice = errString.toString()) }
            }
        }
        runCatching {
            if (pending == null) builder.build().authenticate(signal, mainExecutor, callback)
            else builder.build().authenticate(BiometricPrompt.CryptoObject(pending.cipher), signal, mainExecutor, callback)
        }.onFailure { cancellation = null; state = state.copy(authenticating = false, notice = "Device unlock could not start.") }
    }

    private fun finishUnlock(cookie: String?, attempt: Int) {
        if (attempt != generation || !foreground || !state.configured || !state.cookiesReady) return
        fun ready() {
            if (attempt != generation || !foreground) return
            val resume = state.pickerSuspended && webView != null
            lastCookie = cookie
            state = state.copy(unlocked = true, authenticating = false, pickerSuspended = false,
                loading = !resume, notice = null, connectionError = null,
                webGeneration = state.webGeneration + if (resume) 0 else 1)
            if (resume) { webView?.onResume(); deliverFiles(); pausedCookie = null }
            captureJob?.cancel()
            captureJob = lifecycleScope.launch { while (isActive) { captureSession(); delay(1_200) } }
        }
        if (cookie == null) ready()
        else cookies.setCookie(state.server.home, SessionCookie.restoreHeader(cookie)) { accepted ->
            if (attempt != generation || !foreground) {
                // A late asynchronous restoration must not leave an active
                // cookie behind after the page has been locked/destroyed.
                if (state.useDeviceUnlock) cookies.removeAllCookies { cookies.flush() }
            } else if (accepted) ready()
            else state = state.copy(authenticating = false, notice = "Saved sign-in was rejected. Sign in again.")
        }
    }

    private fun openSavedSession() {
        // Never while the picker is out: resuming it is resumePicker's job, and a second unlock would
        // rebuild the page and lose the files the picker just handed back.
        if (foreground && state.configured && state.cookiesReady && !state.settingsVisible && !state.useDeviceUnlock &&
            !state.pickerSuspended && !state.unlocked)
            finishUnlock(null, generation)
    }

    private fun useServerLogin() {
        if (state.pickerSuspended) lockSession()
        cancelAuthentication(); vault.clear()
        state = state.copy(rememberedSession = false, cookiesReady = false)
        val attempt = generation
        cookies.removeAllCookies {
            state = state.copy(cookiesReady = true)
            finishUnlock(null, attempt)
        }
    }

    private fun captureSession() {
        if (!state.unlocked || !foreground) return
        val view = webView
        view?.evaluateJavascript("document.documentElement.classList.contains('dark')") { result ->
            if (view !== webView || !state.unlocked || !foreground) return@evaluateJavascript
            val dark = result == "true"
            if (dark != state.darkTheme) {
                state = state.copy(darkTheme = dark); preferences.edit().putBoolean("dark_theme", dark).apply(); updateSystemBars()
            }
        }
        if (!state.useDeviceUnlock) return
        val cookie = SessionCookie.extract(cookies.getCookie(state.server.home))
        if (cookie == lastCookie) return
        if (cookie == null) { vault.clear(); state = state.copy(rememberedSession = false) }
        else if (canRemember()) runCatching { vault.store(state.server, cookie) }
            .onSuccess { state = state.copy(rememberedSession = true) }
            .onFailure { state = state.copy(notice = "Sign-in could not be saved securely. Sign in again next time.") }
        lastCookie = cookie
    }

    private fun systemDark(): Boolean =
        resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK == android.content.res.Configuration.UI_MODE_NIGHT_YES

    private fun updateSystemBars() {
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = !state.darkTheme; isAppearanceLightNavigationBars = !state.darkTheme
        }
    }

    private fun lockSession(cancelPrompt: Boolean = true) {
        captureSession(); captureJob?.cancel(); captureJob = null
        if (cancelPrompt) cancelAuthentication()
        denyMicrophonePermission()
        state = state.copy(unlocked = false, pickerSuspended = false, loading = false, cookiesReady = false)
        fileCallback?.onReceiveValue(null); fileCallback = null; pickedFiles = null; pickerReturned = false; pausedCookie = null
        releaseWebView(webView); lastCookie = null
        cookies.removeAllCookies { cookies.flush(); cookiesReady() }
    }

    /** The system picker covers the page for a moment: keep the session, and hand the chosen files back when it closes. */
    private fun suspendForPicker() {
        pausedCookie = SessionCookie.extract(cookies.getCookie(state.server.home))
        captureJob?.cancel(); captureJob = null
        webView?.onPause()
        state = state.copy(unlocked = false, pickerSuspended = true, loading = false)
    }

    private fun resumePicker() {
        if (foreground && state.pickerSuspended) finishUnlock(pausedCookie, generation)
    }

    /**
     * What the picker handed back. FileChooserParams.parseResult reads only the intent's data, but a picker asked for
     * several files (EXTRA_ALLOW_MULTIPLE, as the web app's <input multiple> asks) puts them, even a single one, in
     * its ClipData, and parseResult then returns null: read both.
     */
    private fun pickedUris(resultCode: Int, data: Intent?): Array<Uri>? {
        if (resultCode != RESULT_OK || data == null) return null
        val clip = data.clipData
        val uris = if (clip != null && clip.itemCount > 0) (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri } else listOfNotNull(data.data)
        return uris.filter { it.scheme == "content" }.takeIf { it.isNotEmpty() }?.toTypedArray()
    }

    private fun deliverFiles() {
        if (!pickerReturned || !foreground || !state.unlocked) return
        fileCallback?.onReceiveValue(pickedFiles)
        fileCallback = null; pickedFiles = null; pickerReturned = false
    }

    /** A new page, the same session: the cookies are the session, and only signing out ends it. */
    private fun reloadPage() {
        captureJob?.cancel(); captureJob = null
        denyMicrophonePermission()
        fileCallback?.onReceiveValue(null); fileCallback = null; pickedFiles = null; pickerReturned = false
        releaseWebView(webView)
        state = state.copy(loading = true, pickerSuspended = false, webGeneration = state.webGeneration + 1)
    }

    private fun forgetSession() {
        lockSession(); vault.clear(); WebStorage.getInstance().deleteAllData()
        state = state.copy(rememberedSession = false, notice = "Saved sign-in cleared. Your server still keeps your chats.")
        if (!state.useDeviceUnlock) openSavedSession()
    }

    private fun saveSettings(address: String, unlock: Boolean) {
        val server = try { ServerAddress.parse(address) } catch (error: IllegalArgumentException) {
            state = state.copy(settingsError = error.message); return
        }
        if (unlock && !state.deviceSecure) { state = state.copy(settingsError = "Set up a secure screen lock before enabling device unlock."); return }
        if (!state.configured || server != state.server || unlock != state.useDeviceUnlock) {
            lockSession(); vault.clear(); WebStorage.getInstance().deleteAllData()
        }
        preferences.edit().putString("server", server.origin).putBoolean("device_unlock", unlock).apply()
        state = state.copy(server = server, configured = true, useDeviceUnlock = unlock,
            rememberedSession = vault.hasSession(server), settingsVisible = false, settingsError = null)
        openSavedSession()
    }

    /** Ask locally the first time for this server (an Allow is remembered for it), then require Android's runtime grant for this exact request. */
    private fun offerMicrophone(request: PermissionRequest) {
        if (microphoneRequest != null || !microphoneAllowed(request)) { request.deny(); return }
        microphoneRequest = request
        if (preferences.getBoolean(microphoneKey(), false)) requestMicrophonePermission()
        else state = state.copy(microphonePrompt = true)
    }

    private fun microphoneKey() = "microphone_allowed:${state.server.origin}"

    private fun microphoneAllowed(request: PermissionRequest): Boolean =
        foreground && state.unlocked && !state.settingsVisible && webView?.url?.let(state.server::contains) == true &&
            WebPermissionPolicy.microphone(state.server, request.origin.toString(), request.resources.toList())

    private fun requestMicrophonePermission() {
        state = state.copy(microphonePrompt = false)
        val request = microphoneRequest ?: return
        if (!microphoneAllowed(request)) { denyMicrophonePermission(); return }
        preferences.edit().putBoolean(microphoneKey(), true).apply()
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED)
            finishMicrophonePermission(true)
        else { permissionDialogInFlight = true; recordAudio.launch(Manifest.permission.RECORD_AUDIO) }
    }

    private fun finishMicrophonePermission(granted: Boolean) {
        val request = microphoneRequest ?: return
        microphoneRequest = null; state = state.copy(microphonePrompt = false)
        if (granted && microphoneAllowed(request)) request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
        else request.deny()
    }

    private fun denyMicrophonePermission() {
        microphoneRequest?.deny(); microphoneRequest = null; microphoneResult = null
        state = state.copy(microphonePrompt = false)
    }

    @Suppress("SetJavaScriptEnabled", "DEPRECATION")
    private fun createWebView(): WebView = WebView(this).apply {
        webView = this
        setBackgroundColor(if (state.darkTheme) Color.rgb(24, 24, 25) else Color.rgb(252, 252, 252))
        settings.apply {
            javaScriptEnabled = true; domStorageEnabled = true
            allowFileAccess = false; allowContentAccess = false
            allowFileAccessFromFileURLs = false; allowUniversalAccessFromFileURLs = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            javaScriptCanOpenWindowsAutomatically = false; setSupportMultipleWindows(false)
            safeBrowsingEnabled = true; mediaPlaybackRequiresUserGesture = true
            userAgentString = "$userAgentString AmuseAndroid/${BuildConfig.VERSION_NAME}"
        }
        cookies.setAcceptCookie(true); cookies.setAcceptThirdPartyCookies(this, false)
        webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView, progress: Int) { if (view === webView) state = state.copy(progress = progress) }
            override fun onPermissionRequest(request: PermissionRequest) { runOnUiThread { offerMicrophone(request) } }
            override fun onPermissionRequestCanceled(request: PermissionRequest) {
                if (request === microphoneRequest) { microphoneRequest = null; state = state.copy(microphonePrompt = false) }
            }
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                if (view !== webView || !state.unlocked || !state.server.contains(view.url ?: "")) return false
                fileCallback?.onReceiveValue(null); fileCallback = callback
                val types = params.acceptTypes.filter { it.contains('/') }.toTypedArray()
                val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE); type = if (types.size == 1) types[0] else "*/*"
                    if (types.size > 1) putExtra(Intent.EXTRA_MIME_TYPES, types)
                    putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.mode == FileChooserParams.MODE_OPEN_MULTIPLE)
                }
                runCatching { documentPicker.launch(intent) }.onFailure { fileCallback = null; callback.onReceiveValue(null) }
                return true
            }
        }
        webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (state.server.contains(request.url.toString())) return false
                if (request.isForMainFrame && request.hasGesture()) openExternal(request.url)
                return true
            }
            override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
                if (view !== webView) return
                denyMicrophonePermission()
                if (!state.server.contains(url)) { view.stopLoading(); return }
                state = state.copy(loading = true, progress = 0, connectionError = null)
            }
            override fun onPageFinished(view: WebView, url: String) {
                if (view === webView && state.server.contains(url)) {
                    state = state.copy(loading = false, progress = 100, canGoBack = view.canGoBack()); captureSession(); cookies.flush()
                    reportSavedFiles(view)
                }
            }
            override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
                if (view === webView) state = state.copy(canGoBack = view.canGoBack())
            }
            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (view === webView && request.isForMainFrame) connectionFailed("Could not reach your server. Check that it is online and your network or VPN is connected.")
            }
            override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
                if (view === webView && request.isForMainFrame) connectionFailed("The server returned ${response.statusCode}. Try again in a moment.")
            }
            override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
                handler.cancel()
                if (view === webView) connectionFailed("The server certificate could not be verified. Check its address, certificate and your device clock.")
            }
            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                if (view === webView) {
                    if (state.useDeviceUnlock) lockSession() else reloadPage()
                    state = state.copy(notice = "The web page stopped. Reconnect to continue.")
                    openSavedSession()
                }
                return true
            }
        }
        setDownloadListener { url, agent, disposition, mime, _ ->
            if (this@MainActivity.foreground && state.unlocked && state.server.contains(url)) download(url, agent, disposition, mime)
        }
        loadUrl(state.server.home)
    }

    private fun connectionFailed(message: String) { state = state.copy(loading = false, connectionError = message) }

    /**
     * Saves a download from the server in Downloads/Amuse, under the name the server gives (RFC 5987 `filename*`,
     * which URLUtil.guessFileName ignores: that is how files became `f-<id>.bin`). A sent file's card hears how
     * far it got and why it failed; tapping a file already saved opens that copy instead.
     */
    private fun download(url: String, agent: String, disposition: String?, mime: String?) {
        val server = state.server
        val cookie = cookies.getCookie(server.home)
        val id = Downloads.fileId(Uri.parse(url).path)
        if (id != null && id in downloading) return
        lifecycleScope.launch {
            if (id != null && openSaved(id)) return@launch
            id?.let { downloading += it; reportDownload(Downloads.report(it, "progress", 0, 0)) }
            var reason = "offline"
            val result = runCatching { withContext(Dispatchers.IO) {
                var location = URL(url)
                var connection: HttpsURLConnection? = null
                var saved: Uri? = null
                try {
                    for (redirect in 0..5) {
                        check(server.contains(location.toString())) { "Download left the configured server" }
                        val current = (location.openConnection() as HttpsURLConnection).apply {
                            instanceFollowRedirects = false; connectTimeout = 15_000; readTimeout = 30_000
                            setRequestProperty("User-Agent", agent); cookie?.let { setRequestProperty("Cookie", it) }
                        }
                        connection = current
                        if (current.responseCode in listOf(301, 302, 303, 307, 308)) {
                            location = URL(location, requireNotNull(current.getHeaderField("Location")))
                            current.disconnect(); connection = null; check(redirect < 5); continue
                        }
                        if (current.responseCode !in 200..299) { reason = "server"; error("HTTP ${current.responseCode}") }
                        val header = current.getHeaderField("Content-Disposition") ?: disposition
                        val name = Downloads.fileName(header)
                            ?: URLUtil.guessFileName(location.toString(), header, current.contentType ?: mime).replace(Regex("[/\\\\]"), "_")
                        val type = Downloads.type(current.contentType ?: mime,
                            MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substringAfterLast('.', "").lowercase()))
                        val values = ContentValues().apply {
                            put(MediaStore.Downloads.DISPLAY_NAME, name)
                            put(MediaStore.Downloads.MIME_TYPE, type)
                            put(MediaStore.Downloads.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/Amuse")
                            put(MediaStore.Downloads.IS_PENDING, 1)
                        }
                        reason = "storage"
                        saved = requireNotNull(contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values))
                        val total = current.contentLengthLong
                        requireNotNull(contentResolver.openOutputStream(saved)).use { output -> current.inputStream.use { input ->
                            reason = "offline"
                            val buffer = ByteArray(64 * 1024)
                            var received = 0L; var shown = -1L
                            while (true) {
                                val read = input.read(buffer); if (read < 0) break
                                reason = "storage"; output.write(buffer, 0, read); reason = "offline"
                                received += read
                                // about every percent, or every 256 KB when the size is not known
                                val step = if (total > 0) received * 100 / total else received / (256 * 1024)
                                if (id != null && step != shown) { shown = step; reportDownload(Downloads.report(id, "progress", received, total)) }
                            }
                        } }
                        reason = "storage"
                        contentResolver.update(saved, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
                        return@withContext saved to type
                    }
                    reason = "server"; error("Too many redirects")
                } catch (error: Throwable) { saved?.let { contentResolver.delete(it, null, null) }; throw error }
                finally { connection?.disconnect() }
            } }
            if (id == null) {
                // no card to show it on: a short notice that goes away by itself
                showNotice(result.fold({ "Saved to Downloads/Amuse" }, { "File could not be saved. Check your connection and try again." }))
                return@launch
            }
            downloading -= id
            result.fold({ (uri, type) ->
                savedFiles.edit().putString(id, "$uri\n$type").apply()
                reportDownload(Downloads.report(id, "saved"))
            }, { reportDownload(Downloads.report(id, "failed", reason = reason)) })
        }
    }

    /** Opens the saved copy of a sent file, if it is still there; tells its card when no app takes it. */
    private suspend fun openSaved(id: String): Boolean {
        val (uri, type) = savedCopy(id) ?: return false
        val intent = Intent(Intent.ACTION_VIEW).setDataAndType(uri, type).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        val opened = runCatching { startActivity(intent) }.isSuccess
        reportDownload(Downloads.report(id, if (opened) "saved" else "noApp"))
        return true
    }

    /** Where a sent file was saved, and as what, while that copy is still in Downloads. */
    private suspend fun savedCopy(id: String): Pair<Uri, String>? = withContext(Dispatchers.IO) {
        val (uri, type) = savedFiles.getString(id, null)?.split('\n', limit = 2)?.takeIf { it.size == 2 } ?: return@withContext null
        val there = runCatching { contentResolver.query(Uri.parse(uri), arrayOf(MediaStore.Downloads._ID), null, null, null)?.use { it.count > 0 } }
            .getOrNull() == true
        if (!there) savedFiles.edit().remove(id).apply()
        if (there) Uri.parse(uri) to type else null
    }

    /** Tells the page's cards which sent files are already saved on the phone. */
    private fun reportSavedFiles(view: WebView) = lifecycleScope.launch {
        for (id in savedFiles.all.keys) if (savedCopy(id) != null && view === webView) reportDownload(Downloads.report(id, "saved"))
    }

    /** An `amuse-download` event on the page (only ever the configured server's). */
    private fun reportDownload(detail: String) = runOnUiThread {
        val view = webView ?: return@runOnUiThread
        if (!state.unlocked || !state.server.contains(view.url ?: "")) return@runOnUiThread
        view.evaluateJavascript("window.dispatchEvent(new CustomEvent('amuse-download',{detail:$detail}))", null)
    }

    private fun showNotice(message: String) {
        state = state.copy(notice = message)
        lifecycleScope.launch { delay(4_000); if (state.notice == message) state = state.copy(notice = null) }
    }

    private fun openExternal(uri: Uri) {
        if (uri.scheme != "https" && uri.scheme != "http") return
        runCatching { startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE)) }
            .onFailure { state = state.copy(notice = "No browser is available to open this link.") }
    }

    private fun releaseWebView(view: WebView?) {
        if (view == null || view !== webView) return
        denyMicrophonePermission(); webView = null
        view.stopLoading(); view.onPause(); view.removeAllViews(); view.destroy()
    }
}
