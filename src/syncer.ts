import * as crypto from "crypto";

export interface TachiGameStats {
  userID: number;
  game: string;
}

export interface TachiScore {
  scoreID: string;
  userID: number;
  songID: number;
  chartID: string;
  timeAchieved: number | null;
  scoreData: Record<string, unknown>;
}

export interface TachiSong {
  id: number;
  title: string;
  artist: string;
}

export interface TachiRecentScoresBody {
  scores: TachiScore[];
  songs: TachiSong[];
  charts: unknown[];
}

export interface TachiApiResponse<T> {
  success: boolean;
  description: string;
  body: T;
}

export interface UserSyncState {
  lastSyncedAt: number;
}

export interface UserSyncConfig {
  tachiToken: string;
  tachiBaseUrl: string;

  lastfmApiKey: string;
  lastfmApiSecret: string;
  lastfmSessionKey: string;
}

async function tachiGetAllGames(
  tachiToken: string,
  tachiBaseUrl: string
): Promise<Array<{ game: string }>> {
  const url = `${tachiBaseUrl}/users/me/game-profiles`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${tachiToken}` },
  });

  if (!res.ok) throw new Error(`Tachi HTTP ${res.status} fetching game-stats`);

  const json = (await res.json()) as TachiApiResponse<TachiGameStats[]>;
  if (!json.success) throw new Error(`Tachi error: ${json.description}`);

  return json.body.map(({ game }) => ({ game }));
}

async function tachiGetRecentScores(
  tachiToken: string,
  tachiBaseUrl: string,
  game: string,
): Promise<TachiRecentScoresBody> {
  const url = `${tachiBaseUrl}/users/me/games/${game}/scores/recent`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${tachiToken}` },
  });

  if (!res.ok) throw new Error(`Tachi HTTP ${res.status} on ${url}`);

  const json = (await res.json()) as TachiApiResponse<TachiRecentScoresBody>;
  if (!json.success) throw new Error(`Tachi error: ${json.description}`);
  return json.body;
}

function buildLastfmSignature(
  params: Record<string, string>,
  secret: string
): string {
  const signed = Object.keys(params)
    .filter((k) => k !== "format")
    .sort()
    .map((k) => `${k}${params[k]}`)
    .join("");

  return crypto.createHash("md5").update(signed + secret, "utf8").digest("hex");
}

export interface ScrobblePayload {
  artist: string;
  track: string;
  timestamp: number;
  duration?: number;
}

export async function lastfmScrobbleBatch(
  tracks: ScrobblePayload[],
  config: Pick<UserSyncConfig, "lastfmApiKey" | "lastfmApiSecret" | "lastfmSessionKey">
): Promise<{ accepted: number; ignored: number }> {
  if (tracks.length === 0) return { accepted: 0, ignored: 0 };
  if (tracks.length > 50) throw new Error("Max 50 scrobbles per batch");

  const params: Record<string, string> = {
    method: "track.scrobble",
    api_key: config.lastfmApiKey,
    sk: config.lastfmSessionKey,
    format: "json",
  };

  tracks.forEach((t, i) => {
    params[`artist[${i}]`] = t.artist;
    params[`track[${i}]`] = t.track;
    params[`timestamp[${i}]`] = String(t.timestamp);
    if (t.duration !== undefined) params[`duration[${i}]`] = String(t.duration);
  });

  params.api_sig = buildLastfmSignature(params, config.lastfmApiSecret);

  const res = await fetch("https://ws.audioscrobbler.com/2.0/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });

  const data = (await res.json()) as {
    scrobbles?: { "@attr"?: { accepted: number; ignored: number } };
    error?: number;
    message?: string;
  };

  if (data.error) {
    throw new Error(`Last.fm error ${data.error}: ${data.message}`);
  }

  const attr = data.scrobbles?.["@attr"] ?? { accepted: 0, ignored: 0 };
  return { accepted: attr.accepted, ignored: attr.ignored };
}

export interface SyncResult {
  scrobbled: number;
  ignored: number;
  gamesChecked: number;
  newState: UserSyncState;
}

export async function syncUser(
  config: UserSyncConfig,
  state: UserSyncState
): Promise<SyncResult> {
  const games = await tachiGetAllGames(config.tachiToken, config.tachiBaseUrl);

  if (games.length === 0) {
    return { scrobbled: 0, ignored: 0, gamesChecked: 0, newState: state };
  }

  const perGameResults = await Promise.all(
    games.map(({ game }) =>
      tachiGetRecentScores(config.tachiToken, config.tachiBaseUrl, game).then((v: TachiRecentScoresBody) => {
        return v;
      })
      .catch(
        (err) => {
          console.error(`[scrobbler] Failed to fetch ${game}: ${err.message}`);
          return null;
        }
      )
    )
  );

  const seen = new Set<string>();
  const allNewScores: Array<{ score: TachiScore; song: TachiSong | undefined }> = [];

  for (const result of perGameResults) {
    if (!result) continue;
    const songMap = new Map<number, TachiSong>(result.songs.map((s: TachiSong) => [s.id, s]));

    for (const score of result.scores) {
      if (score.timeAchieved === null) continue;
      if (score.timeAchieved <= state.lastSyncedAt) continue;
      if (seen.has(score.scoreID)) continue;

      seen.add(score.scoreID);
      allNewScores.push({ score, song: songMap.get(score.songID) });
    }
  }

  if (allNewScores.length === 0) {
    return { scrobbled: 0, ignored: 0, gamesChecked: games.length, newState: state };
  }
  
  allNewScores.sort((a, b) => (a.score.timeAchieved as number) - (b.score.timeAchieved as number));

  const payloads: ScrobblePayload[] = allNewScores.map(({ score, song }) => ({
    artist: song?.artist ?? "Unknown Artist",
    track: song?.title ?? "Unknown Track",
    timestamp: Math.floor((score.timeAchieved as number) / 1000),
  }));

  const BATCH = 50;
  let totalAccepted = 0;
  let totalIgnored = 0;
  let newLastSyncedAt = state.lastSyncedAt;

  for (let i = 0; i < payloads.length; i += BATCH) {
    const batchScores = allNewScores.slice(i, i + BATCH);
    const result = await lastfmScrobbleBatch(payloads.slice(i, i + BATCH), config);
    totalAccepted += result.accepted;
    totalIgnored += result.ignored;
    newLastSyncedAt = Math.max(...batchScores.map((s) => s.score.timeAchieved as number));
  }

  return {
    scrobbled: totalAccepted,
    ignored: totalIgnored,
    gamesChecked: games.length,
    newState: { lastSyncedAt: newLastSyncedAt },
  };
}