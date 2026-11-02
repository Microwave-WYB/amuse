# Amuse for Android

A native Android window onto **your own Amuse server**. It loads the server's
existing responsive web UI, so chats, files, settings, browser takeover, terminal,
memory, skills, goals and other web features use the same server state. There is
no second chat database or model configuration in the app.

## Connect

1. Make your server reachable over HTTPS with a valid certificate. Use the same
   address you would open in a phone browser; a reverse proxy or private VPN such
   as Tailscale can provide it. Set the server's `AMUSE_PUBLIC_URL` accordingly.
2. Install a signed APK and enter its HTTPS **origin**, for example
   `https://amuse.example.com` or `https://amuse.example.com:8443`. Paths, query
   strings, credentials and insecure HTTP addresses are rejected.
3. Sign in using the normal Amuse web sign-in page. The native app never handles
   the server password. By default WebView retains the server's session cookie;
   the server can expire or revoke it at any time.

There is no built-in service, account, personal server URL or pairing bypass.
Keep any VPN required to reach your server connected while using the app.

The native toolbar provides connection settings and follows the web UI's light
or dark theme. Android Back follows web history. Connection errors show a retry
button. Screenshots and screen recordings are allowed.

## Optional device lock

Enable **Connection & security → Lock with your device** to require Android's
fingerprint or secure screen-lock credential when reopening the app. A secure
Android screen lock must already be configured. You can always choose server
sign-in instead; that clears the saved native session and cancels an unfinished
file upload.

On Android 11 and later, the reusable server session is encrypted with AES-GCM,
bound to the configured origin. Its random encryption key is wrapped using an
AndroidKeyStore RSA public key; unwrapping requires fresh system authentication
and the corresponding `BiometricPrompt.CryptoObject`. The private key never
leaves Keystore. Passwords and fingerprint data are not stored by native code.
In this mode leaving the app destroys the page and removes active WebView
cookies; startup also clears cookies from an interrupted process before loading
any page. Android 10 supports the local unlock prompt but requires a new server
sign-in when the page is recreated, rather than keeping a reusable vault.

Switching server or lock mode clears the old local session and web storage.
**Clear saved sign-in** removes this device's cookies, local key and saved web
state; chats remain on the server. Android backup is disabled.

## Files and voice

- Uploads use Android's document picker, without storage or camera permission.
  Only `content:` results are accepted. The pending upload is kept behind an
  inaccessible native cover while choosing files; with device lock enabled,
  selected files are not returned to the page until local unlock succeeds.
- Downloads from the configured origin are saved with MediaStore in
  **Downloads/Amuse**, under the name and type the server gives (its RFC 5987
  `filename*`). Every redirect is checked before a cookie is sent; an
  off-origin redirect fails. Failed partial downloads are removed. A sent
  file's card in the chat shows the progress, a failure with its reason and a
  retry button, and once saved, a tap opens the copy in an app that takes it.
  The app reports to the page with `amuse-download` events; the page calls no
  native code, only the download link.
- The web UI's voice button can request the microphone. The app first asks for
  explicit confirmation for the configured origin, then asks Android for
  `RECORD_AUDIO` if needed. It grants only an audio-only request after checking
  the active page, requesting origin and foreground state again. Navigation,
  locking, cancellation or backgrounding cancels pending requests. Camera,
  unknown, mixed-resource and off-origin requests are denied. This only enables
  capture: configure a transcription provider in the server's Voice settings.

WebView stays on the configured HTTPS origin. User-initiated external HTTP(S)
links open in the system browser. File URL access, universal file access, mixed
content, third-party cookies and automatic popups are disabled. TLS errors are
rejected without a bypass. There is no JavaScript native bridge. WebView remote
debugging is enabled only for debug builds.

## Build

Requirements: JDK 17, Android SDK platform 35 and build tools, with `ANDROID_HOME`
pointing to the SDK (or an untracked `local.properties` with `sdk.dir`). The
checked-in Gradle wrapper uses Gradle 8.9; AGP is 8.7.3 and Kotlin is 2.0.21.
Minimum supported Android version is Android 10 / API 29. No emulator is required
for compilation or JVM unit tests.

From `android/`:

```sh
./gradlew --no-daemon assembleDebug testDebugUnitTest assembleRelease
```

On Windows use `gradlew.bat` instead. The outputs are:

- `app/build/outputs/apk/debug/app-debug.apk` (debug signed; development only)
- `app/build/outputs/apk/release/app-release-unsigned.apk`
- `app/build/reports/tests/testDebugUnitTest/index.html`

Release signing is deliberately not configured. Sign the release APK with your
own Android release key using the standard `zipalign` / `apksigner` tools, or
configure your CI's private signing setup outside version control. Keep the same
application ID and signing key for updates; no personal key or machine path is
required by this project.

Release builds run R8 and resource shrinking, so unused Compose icons and
libraries are not included in the distributable APK.

JVM tests cover origin normalization, rejected URL forms, cookie handling and
microphone permission boundaries. Actual WebView rendering, document pickers,
microphone capture, lifecycle transitions and biometric/Keystore behavior also
need device or emulator testing; a successful build is not evidence of those
device-specific behaviors.
