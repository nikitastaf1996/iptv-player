/**
 * IPTV Player — React Native Android app
 *
 * Features:
 *  - Load .m3u / .m3u8 playlist from URL
 *  - Saved playlists library (AsyncStorage) — tap to reload, long-press to delete
 *  - Channel list with logos + group filter + search
 *  - Click to play (HLS via ExoPlayer — no CORS issues)
 *  - Random channel button (prefers alive ones after a scan)
 *  - Scan & Clean: HEAD/GET each stream with timeout, mark dead, remove
 *    Reachability results are PERSISTED — next time you load the same
 *    playlist, the green/red dots come back without re-scanning.
 *  - Export: share the cleaned list as .m3u via Android share sheet
 *
 * Why this works where the browser version didn't:
 *  - ExoPlayer loads HLS streams natively, no browser CORS preflight
 *  - fetch() in RN is native, not subject to browser same-origin policy
 *  - android:usesCleartextTraffic="true" allows http:// streams
 */

import React, { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  Image,
  StyleSheet,
  StatusBar,
  Share,
  Alert,
  ActivityIndicator,
  Dimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Video, { VideoRef, ResizeMode } from 'react-native-video';
import {
  SavedPlaylist,
  ChannelStatusRecord,
  loadSavedPlaylists,
  upsertPlaylist,
  removePlaylist,
  loadChannelStatuses,
  mergeChannelStatuses,
  clearChannelStatuses,
  defaultPlaylistName,
} from './src/storage/Storage';

// ---------- Types ----------
interface Channel {
  name: string;
  url: string;
  logo?: string;
  group?: string;
  status: 'unknown' | 'ok' | 'bad' | 'scanning';
  /** ISO timestamp of the last reachability check, if any. */
  lastCheckedAt?: string | null;
}

// ---------- M3U parser ----------
function parseM3U(text: string): Channel[] {
  const lines = text.split(/\r?\n/);
  const result: Channel[] = [];
  let current: Partial<Channel> | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#EXTM3U')) continue;

    if (line.startsWith('#EXTINF')) {
      const info = line.substring(line.indexOf(':') + 1);
      const attrs: Record<string, string> = {};
      const attrRegex = /([a-zA-Z0-9_-]+)="([^"]*)"/g;
      let m: RegExpExecArray | null;
      while ((m = attrRegex.exec(info)) !== null) {
        attrs[m[1].toLowerCase()] = m[2];
      }
      const lastComma = info.lastIndexOf(',');
      const name = lastComma >= 0 ? info.substring(lastComma + 1).trim() : info.trim();
      current = {
        name: name || 'Unknown Channel',
        logo: attrs['tvg-logo'] || '',
        group: attrs['group-title'] || '',
        status: 'unknown',
      };
    } else if (!line.startsWith('#')) {
      const ch: Channel = current
        ? { ...(current as Channel), url: line }
        : {
            name: 'Channel ' + (result.length + 1),
            url: line,
            status: 'unknown',
          };
      result.push(ch);
      current = null;
    }
  }
  return result;
}

/** Merge persisted reachability records into freshly parsed channels. */
function applyStoredStatuses(
  channels: Channel[],
  records: ChannelStatusRecord[],
): Channel[] {
  if (records.length === 0) return channels;
  const map = new Map<string, ChannelStatusRecord>();
  for (const r of records) map.set(r.url, r);
  return channels.map((c) => {
    const rec = map.get(c.url);
    if (!rec) return c;
    return {
      ...c,
      status: rec.status,
      lastCheckedAt: rec.lastCheckedAt,
    };
  });
}

// ---------- Stream test (for scan) ----------
function testStream(url: string, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      resolve(false);
    }, timeoutMs);

    // For HLS (.m3u8), GET the manifest.
    // For everything else, try GET too — if the server responds at all with 2xx-3xx,
    // consider it alive. We use GET (not HEAD) because some IPTV servers reject HEAD.
    fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { 'User-Agent': 'IPTVPlayer/1.0 Android' },
    })
      .then((res) => {
        clearTimeout(timer);
        resolve(res.status >= 200 && res.status < 400);
      })
      .catch(() => {
        clearTimeout(timer);
        resolve(false);
      });
  });
}

// ---------- Main component ----------
export default function App() {
  const [playlistUrl, setPlaylistUrl] = useState('');
  /** URL of the currently-loaded playlist (used as the storage key). */
  const [activePlaylistUrl, setActivePlaylistUrl] = useState<string>('');
  const [channels, setChannels] = useState<Channel[]>([]);
  const [currentChannel, setCurrentChannel] = useState<Channel | null>(null);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState(0);
  const [scanTotal, setScanTotal] = useState(0);
  const [statusMsg, setStatusMsg] = useState('Load a playlist to begin.');
  const [videoError, setVideoError] = useState<string | null>(null);
  const [isLoadingVideo, setIsLoadingVideo] = useState(false);
  const [savedPlaylists, setSavedPlaylists] = useState<SavedPlaylist[]>([]);

  const videoRef = useRef<VideoRef>(null);
  const scanAbortRef = useRef(false);
  const channelsRef = useRef<Channel[]>([]);
  channelsRef.current = channels;
  const activePlaylistUrlRef = useRef<string>('');
  activePlaylistUrlRef.current = activePlaylistUrl;

  // ---------- Load saved playlists + statuses on mount ----------
  useEffect(() => {
    (async () => {
      const lists = await loadSavedPlaylists();
      setSavedPlaylists(lists);
      if (lists.length > 0) {
        setStatusMsg(`${lists.length} saved playlist${lists.length === 1 ? '' : 's'}. Tap one to load.`);
      }
    })();
  }, []);

  // ---------- Load playlist from URL ----------
  const handleLoad = useCallback(async (urlOverride?: string) => {
    // urlOverride may also be a React Native event object (e.g. when used as
    // onSubmitEditing) — guard with a typeof check.
    const rawUrl =
      typeof urlOverride === 'string' ? urlOverride : playlistUrl;
    const url = rawUrl.trim();
    if (!url) {
      Alert.alert('Enter URL', 'Please paste a playlist URL first.');
      return;
    }
    setLoading(true);
    setStatusMsg('Loading playlist...');
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'IPTVPlayer/1.0 Android' },
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      const parsed = parseM3U(text);
      if (parsed.length === 0) throw new Error('No channels found');

      // Pull any persisted reachability records for this playlist.
      const storedStatuses = await loadChannelStatuses(url);
      const merged = applyStoredStatuses(parsed, storedStatuses);

      setChannels(merged);
      setCurrentChannel(null);
      setVideoError(null);
      setActivePlaylistUrl(url);
      setPlaylistUrl(url);
      setStatusMsg(
        `Loaded ${merged.length} channels` +
          (storedStatuses.length ? ' (reachability restored)' : '') +
          '.',
      );

      // Persist / update the saved-playlist entry.
      const updated = await upsertPlaylist({
        url,
        name: defaultPlaylistName(url),
        lastLoadedAt: new Date().toISOString(),
        channelCount: merged.length,
      });
      setSavedPlaylists(updated);
    } catch (e: any) {
      setStatusMsg('Load failed: ' + (e?.message || String(e)));
      Alert.alert('Load failed', e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [playlistUrl]);

  // ---------- Delete a saved playlist ----------
  const handleDeletePlaylist = useCallback((url: string) => {
    Alert.alert(
      'Remove playlist',
      'Delete this saved playlist and its cached reachability data?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            const updated = await removePlaylist(url);
            setSavedPlaylists(updated);
            if (activePlaylistUrlRef.current === url) {
              setActivePlaylistUrl('');
              setChannels([]);
              setCurrentChannel(null);
              setStatusMsg('Saved playlist removed.');
            }
          },
        },
      ],
    );
  }, []);

  // ---------- Play a channel ----------
  const playChannel = useCallback((ch: Channel) => {
    setCurrentChannel(ch);
    setVideoError(null);
    setIsLoadingVideo(true);
  }, []);

  // ---------- Random ----------
  const handleRandom = useCallback(() => {
    const alive = channelsRef.current.filter((c) => c.status !== 'bad');
    const pool = alive.length > 0 ? alive : channelsRef.current;
    if (pool.length === 0) return;
    const ch = pool[Math.floor(Math.random() * pool.length)];
    playChannel(ch);
    setStatusMsg('Random: ' + ch.name);
  }, [playChannel]);

  // ---------- Scan & Clean ----------
  const handleScan = useCallback(async () => {
    if (channelsRef.current.length === 0) return;
    setScanning(true);
    scanAbortRef.current = false;
    setScanTotal(channelsRef.current.length);
    setScanProgress(0);

    const timeoutMs = 8000;
    const snapshot = channelsRef.current.slice();
    let alive = 0, dead = 0;
    /** Pending reachability updates to persist at the end of the scan. */
    const updates: ChannelStatusRecord[] = [];

    // Run scan sequentially (parallel would hammer the network).
    for (let i = 0; i < snapshot.length; i++) {
      if (scanAbortRef.current) break;
      const ch = snapshot[i];
      setScanProgress(i);
      setStatusMsg(`Scanning ${i + 1}/${snapshot.length}: ${ch.name}`);

      // Mark scanning in place
      setChannels((prev) =>
        prev.map((c) => (c.url === ch.url ? { ...c, status: 'scanning' } : c)),
      );

      const ok = await testStream(ch.url, timeoutMs);
      if (scanAbortRef.current) {
        // User stopped mid-test — restore unknown
        setChannels((prev) =>
          prev.map((c) => (c.url === ch.url ? { ...c, status: 'unknown' } : c)),
        );
        break;
      }
      if (ok) alive++;
      else dead++;
      const now = new Date().toISOString();
      updates.push({ url: ch.url, status: ok ? 'ok' : 'bad', lastCheckedAt: now });
      setChannels((prev) =>
        prev.map((c) =>
          c.url === ch.url
            ? { ...c, status: ok ? 'ok' : 'bad', lastCheckedAt: now }
            : c,
        ),
      );
    }

    // Persist the reachability results for next launch.
    const key = activePlaylistUrlRef.current;
    if (key && updates.length > 0) {
      await mergeChannelStatuses(key, updates);
    }

    if (!scanAbortRef.current) {
      // Remove dead channels
      setChannels((prev) => prev.filter((c) => c.status !== 'bad'));
      setStatusMsg(`Scan done. ${alive} alive, ${dead} dead removed.`);
    } else {
      setStatusMsg(`Scan stopped. ${alive} alive, ${dead} dead so far.`);
    }

    setScanning(false);
    setScanProgress(0);
    setScanTotal(0);
  }, []);

  const handleStopScan = useCallback(() => {
    scanAbortRef.current = true;
  }, []);

  // ---------- Reset reachability ----------
  const handleResetStatuses = useCallback(async () => {
    if (!activePlaylistUrl) {
      Alert.alert('No playlist', 'Load a playlist first.');
      return;
    }
    Alert.alert(
      'Reset reachability',
      'Clear all saved ok/bad markers for this playlist? Channels will go back to "unknown".',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset',
          style: 'destructive',
          onPress: async () => {
            await clearChannelStatuses(activePlaylistUrl);
            setChannels((prev) =>
              prev.map((c) => ({ ...c, status: 'unknown', lastCheckedAt: null })),
            );
            setStatusMsg('Reachability data cleared.');
          },
        },
      ],
    );
  }, [activePlaylistUrl]);

  // ---------- Export .m3u ----------
  const handleExport = useCallback(async () => {
    const toExport = channelsRef.current.filter((c) => c.status !== 'bad');
    if (toExport.length === 0) {
      Alert.alert('Nothing to export', 'All channels are marked dead.');
      return;
    }
    const lines = ['#EXTM3U'];
    for (const ch of toExport) {
      const attrs: string[] = [];
      if (ch.logo) attrs.push(`tvg-logo="${ch.logo}"`);
      if (ch.group) attrs.push(`group-title="${ch.group}"`);
      const attrStr = attrs.length ? ' ' + attrs.join(' ') : '';
      lines.push(`#EXTINF:-1${attrStr},${ch.name}`);
      lines.push(ch.url);
    }
    const content = lines.join('\n') + '\n';
    const skipped = channelsRef.current.length - toExport.length;
    try {
      await Share.share({
        message: content,
        title: 'iptv-cleaned.m3u',
      });
      setStatusMsg(
        `Exported ${toExport.length} channels` +
          (skipped ? `, ${skipped} dead skipped` : '') +
          '.',
      );
    } catch (e: any) {
      Alert.alert('Export failed', e?.message || String(e));
    }
  }, []);

  // ---------- Video callbacks ----------
  const onVideoLoad = useCallback(() => {
    setIsLoadingVideo(false);
  }, []);
  const onVideoError = useCallback((e: any) => {
    setIsLoadingVideo(false);
    const err = e?.error;
    const msg =
      err?.errorString || err?.message || 'Unknown playback error';
    setVideoError(msg);
  }, []);

  // ---------- Stats ----------
  const stats = useMemo(() => {
    let ok = 0, bad = 0;
    for (const c of channels) {
      if (c.status === 'ok') ok++;
      else if (c.status === 'bad') bad++;
    }
    return { total: channels.length, ok, bad };
  }, [channels]);

  const filteredChannels = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return channels;
    return channels.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        (c.group && c.group.toLowerCase().includes(q)),
    );
  }, [channels, search]);

  // ---------- Render ----------
  const renderSavedPlaylist = ({ item }: { item: SavedPlaylist }) => {
    const isActive = activePlaylistUrl === item.url;
    return (
      <TouchableOpacity
        style={[styles.savedChip, isActive && styles.savedChipActive]}
        onPress={() => handleLoad(item.url)}
        onLongPress={() => handleDeletePlaylist(item.url)}
        disabled={loading || scanning}
      >
        <Text
          style={[styles.savedChipText, isActive && styles.savedChipTextActive]}
          numberOfLines={1}
        >
          {item.name}
        </Text>
        <Text style={styles.savedChipMeta}>{item.channelCount} ch</Text>
      </TouchableOpacity>
    );
  };

  const renderChannel = ({ item }: { item: Channel }) => {
    const isActive = currentChannel?.url === item.url;
    const initial = item.name.charAt(0).toUpperCase();
    return (
      <TouchableOpacity
        style={[styles.channelItem, isActive && styles.channelItemActive]}
        onPress={() => playChannel(item)}
        disabled={item.status === 'bad'}
      >
        {item.logo ? (
          <Image
            source={{ uri: item.logo }}
            style={styles.channelLogo}
            resizeMode="contain"
          />
        ) : (
          <View style={[styles.channelLogo, styles.channelLogoPlaceholder]}>
            <Text style={styles.channelLogoText}>{initial}</Text>
          </View>
        )}
        <View style={styles.channelInfo}>
          <Text
            style={[styles.channelName, item.status === 'bad' && styles.channelNameDead]}
            numberOfLines={1}
          >
            {item.name}
          </Text>
          {item.group ? (
            <Text style={styles.channelGroup} numberOfLines={1}>
              {item.group}
            </Text>
          ) : null}
          {item.lastCheckedAt ? (
            <Text style={styles.channelLastChecked} numberOfLines={1}>
              checked {formatRelative(item.lastCheckedAt)}
            </Text>
          ) : null}
        </View>
        <View
          style={[
            styles.statusDot,
            item.status === 'ok' && styles.statusOk,
            item.status === 'bad' && styles.statusBad,
            item.status === 'scanning' && styles.statusScanning,
            item.status === 'unknown' && styles.statusUnknown,
          ]}
        />
      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <StatusBar barStyle="light-content" backgroundColor="#0f1115" />
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>
          <Text style={styles.headerDot}>● </Text>IPTV Player
        </Text>
      </View>

      {/* Saved playlists */}
      {savedPlaylists.length > 0 ? (
        <View style={styles.savedWrap}>
          <FlatList
            horizontal
            data={savedPlaylists}
            keyExtractor={(item) => item.url}
            renderItem={renderSavedPlaylist}
            showsHorizontalScrollIndicator={false}
            ItemSeparatorComponent={() => <View style={{ width: 8 }} />}
          />
        </View>
      ) : null}

      {/* Toolbar */}
      <View style={styles.toolbar}>
        <TextInput
          style={styles.urlInput}
          value={playlistUrl}
          onChangeText={setPlaylistUrl}
          placeholder="Paste M3U / M3U8 playlist URL..."
          placeholderTextColor="#6b7280"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          onSubmitEditing={handleLoad}
        />
        <TouchableOpacity
          style={[styles.btn, styles.btnPrimary, loading && styles.btnDisabled]}
          onPress={handleLoad}
          disabled={loading || scanning}
        >
          <Text style={styles.btnPrimaryText}>
            {loading ? 'Loading...' : 'Load'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Action row */}
      <View style={styles.actionRow}>
        <TouchableOpacity
          style={[styles.btn, channels.length === 0 && styles.btnDisabled]}
          onPress={handleRandom}
          disabled={channels.length === 0 || scanning}
        >
          <Text style={styles.btnText}>🔀 Random</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[
            styles.btn,
            styles.btnDanger,
            (channels.length === 0 || scanning) && styles.btnDisabled,
          ]}
          onPress={handleScan}
          disabled={channels.length === 0 || scanning}
        >
          <Text style={styles.btnDangerText}>🩺 Scan &amp; Clean</Text>
        </TouchableOpacity>
        {scanning ? (
          <TouchableOpacity
            style={[styles.btn, styles.btnWarn]}
            onPress={handleStopScan}
          >
            <Text style={styles.btnText}>⏹ Stop</Text>
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity
          style={[
            styles.btn,
            (!activePlaylistUrl || scanning) && styles.btnDisabled,
          ]}
          onPress={handleResetStatuses}
          disabled={!activePlaylistUrl || scanning}
        >
          <Text style={styles.btnText}>♻️ Reset</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.btn, channels.length === 0 && styles.btnDisabled]}
          onPress={handleExport}
          disabled={channels.length === 0 || scanning}
        >
          <Text style={styles.btnText}>💾 Export</Text>
        </TouchableOpacity>
      </View>

      {/* Status bar */}
      <View style={styles.statusBar}>
        <Text style={styles.statItem}>
          Total: <Text style={styles.statVal}>{stats.total}</Text>
        </Text>
        <Text style={styles.statItem}>
          Alive: <Text style={[styles.statVal, { color: '#22c55e' }]}>{stats.ok}</Text>
        </Text>
        <Text style={styles.statItem}>
          Dead: <Text style={[styles.statVal, { color: '#ef4444' }]}>{stats.bad}</Text>
        </Text>
        <Text style={styles.statusMsg} numberOfLines={1}>
          {statusMsg}
        </Text>
      </View>

      {/* Scan progress bar */}
      {scanning && scanTotal > 0 ? (
        <View style={styles.progressBar}>
          <View
            style={[
              styles.progressFill,
              { width: `${(scanProgress / scanTotal) * 100}%` },
            ]}
          />
        </View>
      ) : null}

      {/* Video player */}
      <View style={styles.videoWrap}>
        {currentChannel ? (
          <>
            <Video
              ref={videoRef}
              source={{ uri: currentChannel.url }}
              style={styles.video}
              resizeMode={ResizeMode.CONTAIN}
              controls
              paused={false}
              onLoad={onVideoLoad}
              onError={onVideoError}
              bufferConfig={{
                minBufferMs: 15000,
                maxBufferMs: 50000,
                bufferForPlaybackMs: 2500,
                bufferForPlaybackAfterRebufferMs: 5000,
              }}
            />
            {isLoadingVideo && !videoError ? (
              <View style={styles.videoOverlay}>
                <ActivityIndicator size="large" color="#4f8cff" />
                <Text style={styles.videoOverlayText}>Loading stream...</Text>
              </View>
            ) : null}
            {videoError ? (
              <View style={styles.videoOverlay}>
                <Text style={styles.videoOverlayText}>Stream error:</Text>
                <Text style={[styles.videoOverlayText, { marginTop: 4 }]}>
                  {videoError}
                </Text>
              </View>
            ) : null}
          </>
        ) : (
          <View style={styles.videoOverlay}>
            <Text style={styles.videoOverlayText}>No channel selected</Text>
          </View>
        )}
      </View>

      {/* Now playing */}
      <View style={styles.nowPlaying}>
        <Text style={styles.npLabel}>NOW PLAYING</Text>
        <Text style={styles.npTitle} numberOfLines={1}>
          {currentChannel?.name || '—'}
        </Text>
        {currentChannel?.group ? (
          <Text style={styles.npGroup} numberOfLines={1}>
            {currentChannel.group}
          </Text>
        ) : null}
      </View>

      {/* Search */}
      <View style={styles.searchWrap}>
        <TextInput
          style={styles.searchInput}
          value={search}
          onChangeText={setSearch}
          placeholder="Filter channels..."
          placeholderTextColor="#6b7280"
        />
      </View>

      {/* Channel list */}
      <FlatList
        style={styles.channelList}
        data={filteredChannels}
        keyExtractor={(item, idx) => item.url + idx}
        renderItem={renderChannel}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Text style={styles.emptyStateText}>
              {channels.length === 0
                ? 'No channels loaded yet.\nEnter a playlist URL above and tap Load.'
                : 'No channels match your filter.'}
            </Text>
          </View>
        }
        ItemSeparatorComponent={() => <View style={styles.separator} />}
      />
    </SafeAreaView>
  );
}

// ---------- Helpers ----------
function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Date.now() - then;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}

// ---------- Styles ----------
const { width: SCREEN_WIDTH } = Dimensions.get('window');
const VIDEO_HEIGHT = Math.round((SCREEN_WIDTH * 9) / 16);

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f1115',
  },
  header: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
  },
  headerTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: '#e6e8ec',
    letterSpacing: -0.3,
  },
  headerDot: {
    color: '#4f8cff',
  },
  savedWrap: {
    paddingBottom: 8,
    paddingHorizontal: 12,
  },
  savedChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1e222b',
    borderWidth: 1,
    borderColor: '#2a2f3a',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 16,
    gap: 6,
  },
  savedChipActive: {
    backgroundColor: 'rgba(79, 140, 255, 0.18)',
    borderColor: '#4f8cff',
  },
  savedChipText: {
    color: '#e6e8ec',
    fontSize: 12,
    fontWeight: '500',
    maxWidth: 140,
  },
  savedChipTextActive: {
    color: '#4f8cff',
  },
  savedChipMeta: {
    color: '#8b94a7',
    fontSize: 10,
  },
  toolbar: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    paddingBottom: 8,
    gap: 8,
  },
  urlInput: {
    flex: 1,
    backgroundColor: '#171a21',
    borderWidth: 1,
    borderColor: '#2a2f3a',
    color: '#e6e8ec',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    fontSize: 14,
  },
  actionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 12,
    paddingBottom: 8,
    gap: 8,
  },
  btn: {
    backgroundColor: '#1e222b',
    borderWidth: 1,
    borderColor: '#2a2f3a',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
  },
  btnPrimary: {
    backgroundColor: '#4f8cff',
    borderColor: '#4f8cff',
  },
  btnDanger: {
    borderColor: '#4a2a2a',
  },
  btnWarn: {
    borderColor: '#6b4a1a',
    backgroundColor: '#2a1f0f',
  },
  btnDisabled: {
    opacity: 0.4,
  },
  btnText: {
    color: '#e6e8ec',
    fontSize: 13,
    fontWeight: '500',
  },
  btnPrimaryText: {
    color: 'white',
    fontSize: 13,
    fontWeight: '600',
  },
  btnDangerText: {
    color: '#ffb4b4',
    fontSize: 13,
    fontWeight: '500',
  },
  statusBar: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: '#171a21',
    marginHorizontal: 12,
    marginBottom: 8,
    borderRadius: 8,
    gap: 12,
  },
  statItem: {
    color: '#8b94a7',
    fontSize: 12,
  },
  statVal: {
    color: '#e6e8ec',
    fontWeight: '700',
  },
  statusMsg: {
    color: '#8b94a7',
    fontSize: 12,
    flex: 1,
    minWidth: 100,
  },
  progressBar: {
    height: 3,
    backgroundColor: '#1e222b',
    marginHorizontal: 12,
    marginBottom: 8,
    borderRadius: 1.5,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#4f8cff',
  },
  videoWrap: {
    width: SCREEN_WIDTH,
    height: VIDEO_HEIGHT,
    backgroundColor: '#000',
    justifyContent: 'center',
    alignItems: 'center',
  },
  video: {
    width: SCREEN_WIDTH,
    height: VIDEO_HEIGHT,
    backgroundColor: '#000',
  },
  videoOverlay: {
    position: 'absolute',
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.6)',
    padding: 16,
  },
  videoOverlayText: {
    color: '#e6e8ec',
    fontSize: 13,
    textAlign: 'center',
  },
  nowPlaying: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: '#171a21',
    borderBottomWidth: 1,
    borderBottomColor: '#2a2f3a',
  },
  npLabel: {
    color: '#6b7280',
    fontSize: 10,
    letterSpacing: 0.6,
    fontWeight: '600',
    marginBottom: 2,
  },
  npTitle: {
    color: '#e6e8ec',
    fontSize: 15,
    fontWeight: '600',
  },
  npGroup: {
    color: '#8b94a7',
    fontSize: 12,
    marginTop: 2,
  },
  searchWrap: {
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  searchInput: {
    backgroundColor: '#171a21',
    borderWidth: 1,
    borderColor: '#2a2f3a',
    color: '#e6e8ec',
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 6,
    fontSize: 13,
  },
  channelList: {
    flex: 1,
    backgroundColor: '#171a21',
  },
  channelItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 9,
    gap: 10,
    backgroundColor: '#171a21',
  },
  channelItemActive: {
    backgroundColor: 'rgba(79, 140, 255, 0.15)',
  },
  channelLogo: {
    width: 36,
    height: 36,
    borderRadius: 6,
    backgroundColor: '#1e222b',
  },
  channelLogoPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  channelLogoText: {
    color: '#8b94a7',
    fontSize: 14,
    fontWeight: '700',
  },
  channelInfo: {
    flex: 1,
    minWidth: 0,
  },
  channelName: {
    color: '#e6e8ec',
    fontSize: 13,
    fontWeight: '500',
  },
  channelNameDead: {
    opacity: 0.35,
  },
  channelGroup: {
    color: '#8b94a7',
    fontSize: 11,
    marginTop: 2,
  },
  channelLastChecked: {
    color: '#5b6478',
    fontSize: 10,
    marginTop: 1,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#4a4f5a',
  },
  statusOk: { backgroundColor: '#22c55e' },
  statusBad: { backgroundColor: '#ef4444' },
  statusScanning: { backgroundColor: '#f59e0b' },
  statusUnknown: { backgroundColor: '#4a4f5a' },
  separator: {
    height: 1,
    backgroundColor: '#1d2129',
    marginLeft: 58,
  },
  emptyState: {
    padding: 40,
    alignItems: 'center',
  },
  emptyStateText: {
    color: '#8b94a7',
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 20,
  },
});
