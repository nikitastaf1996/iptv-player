/**
 * Persistent storage for IPTV Player.
 *
 * Two namespaces in AsyncStorage:
 *   - "iptvplayer.playlists"        → SavedPlaylist[]   (the playlist library)
 *   - "iptvplayer.statuses.<url>"   → ChannelStatusRecord[]  (per-playlist reachability)
 *
 * All public functions are resilient to JSON parse errors and return safe
 * defaults (empty array) instead of throwing.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

// ---------- Types ----------

/** A user-saved playlist URL with metadata. */
export interface SavedPlaylist {
  /** The playlist URL — used as the primary key. */
  url: string;
  /** Friendly label shown in the UI. Defaults to the URL host. */
  name: string;
  /** ISO timestamp of the last successful load. */
  lastLoadedAt: string | null;
  /** Channel count at the last successful load. */
  channelCount: number;
}

/** Persisted reachability record for a single channel under a playlist. */
export interface ChannelStatusRecord {
  /** Channel stream URL — used as the key within a playlist. */
  url: string;
  /** Last reachability result. */
  status: 'ok' | 'bad' | 'unknown';
  /** ISO timestamp of the last reachability check. */
  lastCheckedAt: string | null;
}

// ---------- Keys ----------

const PLAYLISTS_KEY = 'iptvplayer.playlists';
const statusesKey = (playlistUrl: string) =>
  `iptvplayer.statuses.${playlistUrl}`;

// ---------- Playlists ----------

export async function loadSavedPlaylists(): Promise<SavedPlaylist[]> {
  try {
    const raw = await AsyncStorage.getItem(PLAYLISTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isSavedPlaylist);
  } catch {
    return [];
  }
}

export async function saveSavedPlaylists(
  playlists: SavedPlaylist[],
): Promise<void> {
  try {
    await AsyncStorage.setItem(PLAYLISTS_KEY, JSON.stringify(playlists));
  } catch {
    /* swallow — best-effort persistence */
  }
}

/**
 * Upsert a playlist entry. If a playlist with the same URL already exists,
 * its metadata is updated; otherwise a new entry is appended.
 */
export async function upsertPlaylist(
  playlist: SavedPlaylist,
): Promise<SavedPlaylist[]> {
  const current = await loadSavedPlaylists();
  const idx = current.findIndex((p) => p.url === playlist.url);
  let next: SavedPlaylist[];
  if (idx >= 0) {
    next = current.slice();
    next[idx] = { ...current[idx], ...playlist };
  } else {
    next = [playlist, ...current];
  }
  await saveSavedPlaylists(next);
  return next;
}

export async function removePlaylist(url: string): Promise<SavedPlaylist[]> {
  const current = await loadSavedPlaylists();
  const next = current.filter((p) => p.url !== url);
  await saveSavedPlaylists(next);
  // Also drop any cached reachability records for that URL.
  try {
    await AsyncStorage.removeItem(statusesKey(url));
  } catch {
    /* ignore */
  }
  return next;
}

// ---------- Channel statuses ----------

export async function loadChannelStatuses(
  playlistUrl: string,
): Promise<ChannelStatusRecord[]> {
  try {
    const raw = await AsyncStorage.getItem(statusesKey(playlistUrl));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isChannelStatusRecord);
  } catch {
    return [];
  }
}

export async function saveChannelStatuses(
  playlistUrl: string,
  records: ChannelStatusRecord[],
): Promise<void> {
  try {
    await AsyncStorage.setItem(
      statusesKey(playlistUrl),
      JSON.stringify(records),
    );
  } catch {
    /* swallow */
  }
}

/**
 * Merge new reachability results into whatever is already stored for the
 * playlist. Matching is by channel URL.
 */
export async function mergeChannelStatuses(
  playlistUrl: string,
  updates: ChannelStatusRecord[],
): Promise<ChannelStatusRecord[]> {
  if (!playlistUrl || updates.length === 0) {
    return loadChannelStatuses(playlistUrl);
  }
  const current = await loadChannelStatuses(playlistUrl);
  const byUrl = new Map<string, ChannelStatusRecord>();
  for (const r of current) byUrl.set(r.url, r);
  const now = new Date().toISOString();
  for (const u of updates) {
    byUrl.set(u.url, {
      url: u.url,
      status: u.status,
      lastCheckedAt: u.lastCheckedAt ?? now,
    });
  }
  const next = Array.from(byUrl.values());
  await saveChannelStatuses(playlistUrl, next);
  return next;
}

export async function clearChannelStatuses(
  playlistUrl: string,
): Promise<void> {
  try {
    await AsyncStorage.removeItem(statusesKey(playlistUrl));
  } catch {
    /* ignore */
  }
}

// ---------- Helpers ----------

function isSavedPlaylist(x: any): x is SavedPlaylist {
  return (
    x &&
    typeof x === 'object' &&
    typeof x.url === 'string' &&
    typeof x.name === 'string' &&
    (x.lastLoadedAt === null || typeof x.lastLoadedAt === 'string') &&
    typeof x.channelCount === 'number'
  );
}

function isChannelStatusRecord(x: any): x is ChannelStatusRecord {
  return (
    x &&
    typeof x === 'object' &&
    typeof x.url === 'string' &&
    (x.status === 'ok' || x.status === 'bad' || x.status === 'unknown') &&
    (x.lastCheckedAt === null || typeof x.lastCheckedAt === 'string')
  );
}

/** Build a friendly default name from a URL (the host, without scheme). */
export function defaultPlaylistName(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname || url;
  } catch {
    return url.length > 40 ? url.slice(0, 37) + '…' : url;
  }
}
