# IPTV Player (Android)

React Native Android app for playing `.m3u` / `.m3u8` IPTV playlists.

## Features

- **Load playlist** from URL (M3U / M3U8 format)
- **Channel list** with logos, group labels, and live search filter
- **Click to play** — HLS streams played natively via ExoPlayer (no CORS issues that plague browser players)
- **Random** button — picks a random channel (prefers ones still alive after a scan)
- **Scan & Clean** — tests each stream with an 8s timeout, marks dead, removes them from the list
- **Export** — share the cleaned `.m3u` file via Android share sheet (save to device, send to VLC, etc.)
- **Cleartext traffic allowed** — HTTP (non-HTTPS) streams work, since most IPTV streams are still served over plain HTTP

## Why React Native (vs. the browser version)

The browser-based HTML player suffers from CORS restrictions on most IPTV stream URLs. React Native uses native `fetch` and ExoPlayer for video playback, neither of which enforces browser CORS policy. HTTP (cleartext) streams also work fine.

## Download APK

### Latest build (auto-published on every push)

Direct download — always points to the freshest APK:

```
https://github.com/nikitastaf1996/iptv-player/releases/download/latest/iptv-player-latest.apk
```

Or browse all releases: https://github.com/nikitastaf1996/iptv-player/releases

### Stable versioned release

[v1.0.0](https://github.com/nikitastaf1996/iptv-player/releases/tag/v1.0.0) — `iptv-player-v1.0.0.apk`

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

## Tech stack

- React Native 0.86
- TypeScript
- react-native-video 6.x (ExoPlayer backend)
- Gradle 8 + Android SDK 35
