# IPTV Player (Android)

React Native Android app for playing `.m3u` / `.m3u8` IPTV playlists.

## Features

- **Load playlist** from URL (M3U / M3U8 format)
- **Saved playlists library** — every loaded playlist is saved to device storage. Tap a chip at the top to reload it; long-press to delete
- **Channel list** with logos, group labels, and live search filter
- **Persisted reachability** — Scan results (ok / bad) are stored per-channel. Reload a playlist later and the green/red dots come back immediately, no rescan needed
- **Click to play** — HLS streams played natively via ExoPlayer (no CORS issues that plague browser players)
- **Random** button — strict priority: alive (green) channels first, falls back to unknown (grey) only if no alive ones exist. Dead channels are never picked
- **Scan & Clean (background)** — tests each stream with an 8s timeout, marks dead, removes them from the list. Runs as an Android **foreground service** with a persistent notification, so you can leave the app, switch to other apps, or turn off the screen and the scan keeps going. Progress is also saved to storage every 10 channels so a force-kill can't lose much
- **Reset** — wipe saved reachability data for the active playlist and start fresh
- **Export** — share the cleaned `.m3u` file via Android share sheet (save to device, send to VLC, etc.)
- **Picture-in-Picture** — press Home while a stream is playing and the video slides into a floating window that stays on top of other apps. You can also tap the **⧉ PiP** badge on the player to enter PiP manually
- **Cleartext traffic allowed** — HTTP (non-HTTPS) streams work, since most IPTV streams are still served over plain HTTP

## Why React Native (vs. the browser version)

The browser-based HTML player suffers from CORS restrictions on most IPTV stream URLs. React Native uses native `fetch` and ExoPlayer for video playback, neither of which enforces browser CORS policy. HTTP (cleartext) streams also work fine.

## What's new in v1.2.0

- **Background scan** — the Scan & Clean operation now runs inside an Android foreground service. A persistent notification shows live progress (`123/1500 — Channel Name`). You can press Home, switch apps, or lock the screen — the scan keeps running. Results are persisted to AsyncStorage every 10 channels so an OS kill won't wipe everything. When you return to the app, the channel list refreshes from storage and reflects the latest scan progress.
- **Smarter Random button** — previously the Random button picked any non-dead channel (so an unknown one could be picked over a known-alive one). Now the priority is strict: **alive (ok) > unknown, dead is never selected**. If the alive pool is non-empty, only alive channels are picked; only when there are zero alive channels do we fall back to unknown ones.
- **Picture-in-Picture** — added full PiP support. The activity is registered with `supportsPictureInPicture` and `resizeableActivity`. A small Kotlin bridge (`PiPModule`) lets the JS side tell native code whether a stream is currently playing. When you press Home with a stream active, `MainActivity.onUserLeaveHint()` slides the video into PiP (16:9 aspect ratio, auto-enter on Android 12+). There is also a manual **⧉ PiP** button on the video player.

## Download APK

### Latest build (auto-published on every push)

Direct download — always points to the freshest APK:

```
https://github.com/nikitastaf1996/iptv-player/releases/download/latest/iptv-player-latest.apk
```

Or browse all releases: https://github.com/nikitastaf1996/iptv-player/releases

### Stable versioned release

[v1.2.0](https://github.com/nikitastaf1996/iptv-player/releases/tag/v1.2.0) — `iptv-player-v1.2.0.apk`

### Install

1. Download the `.apk` file above
2. Transfer to your Android device (or download directly on the phone)
3. Tap to install — enable "Install unknown apps" for your file manager / browser if prompted
4. Open **IPTV Player** from your app drawer

The APK is signed with the standard Android debug keystore — sideloadable, NOT Play-Store-ready.

## Build locally

Requirements: Node 22+, JDK 17, Android SDK 35 + NDK 27.1.12297006.

```bash
npm install
cd android
./gradlew assembleRelease
# APK at android/app/build/outputs/apk/release/app-release.apk
```

## Permissions

| Permission | Why |
|---|---|
| `INTERNET` | Fetch playlists and stream video |
| `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_DATA_SYNC` | Run the channel scan in the background as a foreground service |
| `POST_NOTIFICATIONS` | Show the scan progress notification (Android 13+) |
| `WAKE_LOCK` | Keep the CPU awake during long background scans |

PiP does not require a separate permission — it's enabled per-activity via `android:supportsPictureInPicture="true"`.

## Tech stack

- React Native 0.86
- TypeScript
- react-native-video 6.x (ExoPlayer backend)
- react-native-background-actions 4.x (foreground service for background scan)
- @react-native-async-storage/async-storage (playlist library + per-channel reachability)
- Gradle 8 + Android SDK 35
