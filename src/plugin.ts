import Elysia from "elysia";
import { UserStore, tachiAuthUrl, tachiExchangeCode, lastfmAuthUrl, lastfmExchangeToken } from "./auth";
import { syncUser } from "./syncer";

export interface ScrobblerPluginConfig {
  tachiClientId: string;
  tachiClientSecret: string;

  tachiRedirectUri: string;
  tachiApiBaseUrl: string;
  tachiWebBaseUrl: string;

  lastfmApiKey: string;
  lastfmApiSecret: string;
  lastfmCallbackUrl: string;

  intervalMs?: number;
  storageFile?: string;
}

export function tachiScrobblerPlugin(config: ScrobblerPluginConfig) {
  const intervalMs = config.intervalMs ?? 5 * 60 * 1000;
  const storageFile = config.storageFile ?? ".scrobbler-users.json";

  const store = new UserStore(storageFile);
  const pendingLastfm = new Map<number, number>();

  async function syncAll() {
    const users = store.getAll().filter((u) => u.lastfmSessionKey);
    if (users.length === 0) return;

    console.log(`[scrobbler] syncing ${users.length} users`)

    for (const user of users) {
      try {
        console.log(`[scrobbler] syncing user ${user.tachiUsername}`)
        const result = await syncUser(
          {
            tachiToken: user.tachiToken,
            tachiBaseUrl: config.tachiApiBaseUrl,
            lastfmApiKey: config.lastfmApiKey,
            lastfmApiSecret: config.lastfmApiSecret,
            lastfmSessionKey: user.lastfmSessionKey!,
          },
          { lastSyncedAt: user.lastSyncedAt }
        );

        if (result.scrobbled > 0) {
          console.log(
            `[scrobbler] ${user.tachiUsername} → ${result.scrobbled} scrobbled, ${result.ignored} ignored across ${result.gamesChecked} game(s)`
          );
          await store.updateSyncState(user.tachiUserId, result.newState.lastSyncedAt);
        }
      } catch (err) {
        console.error(`[scrobbler] Error syncing ${user.tachiUsername}:`, err);
      }
    }
  }

  store.load().then(() => {
    console.log(`[scrobbler] Loaded ${store.getAll().length} user(s). Interval: ${intervalMs / 1000}s`);
    syncAll();
    setInterval(syncAll, intervalMs);
  });

  return new Elysia({ prefix: "/scrobbler" })
    .get("/status", () => {
      const users = store.getAll().map((u) => ({
        tachiUsername: u.tachiUsername,
        lastfmUsername: u.lastfmUsername ?? null,
        connected: !!u.lastfmSessionKey,
        lastSyncedAt: u.lastSyncedAt,
      }));
      return { ok: true, users };
    })

    .get("/connect/tachi", ({ redirect }) => {
      const url = tachiAuthUrl(config.tachiClientId, config.tachiWebBaseUrl);
      return redirect(url)
    })

    .get("/callback/tachi", async ({ query, set, redirect }) => {
      const code = query.code as string | undefined;
      if (!code) {
        set.status = 400;
        return { error: "Missing code parameter" };
      }

      let tachiUserId: number;
      let tachiUsername: string;
      let tachiToken: string;

      try {
        const result = await tachiExchangeCode(code, {
          clientId: config.tachiClientId,
          clientSecret: config.tachiClientSecret,
          redirectUri: config.tachiRedirectUri,
          baseUrl: config.tachiApiBaseUrl,
        });
        tachiUserId = result.tachiUserId;
        tachiUsername = result.tachiUsername;
        tachiToken = result.token;
      } catch (err) {
        set.status = 502;
        return { error: `Tachi auth failed: ${(err as Error).message}` };
      }

      const existing = store.get(tachiUserId);
      await store.upsert({
        tachiUserId,
        tachiUsername,
        tachiToken,
        lastfmSessionKey: existing?.lastfmSessionKey,
        lastfmUsername: existing?.lastfmUsername,
        lastSyncedAt: existing?.lastSyncedAt ?? 0,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
      });

      const lfmUrl = lastfmAuthUrl({
        apiKey: config.lastfmApiKey,
        callbackUrl: `${config.lastfmCallbackUrl}?tachiId=${tachiUserId}`,
      });
      return redirect(lfmUrl)
    })

    .get("/callback/lastfm", async ({ query, set, redirect }) => {
      const token = query.token as string | undefined;
      const tachiId = query.tachiId ? Number(query.tachiId) : undefined;

      if (!token || !tachiId) {
        set.status = 400;
        return { error: "Missing token or tachiId parameter" };
      }

      const user = store.get(tachiId);
      if (!user) {
        set.status = 404;
        return { error: "Unknown tachiId — complete the Tachi step first" };
      }

      let sessionKey: string;
      let lastfmUsername: string;

      try {
        const result = await lastfmExchangeToken(token, {
          apiKey: config.lastfmApiKey,
          apiSecret: config.lastfmApiSecret,
        });
        sessionKey = result.sessionKey;
        lastfmUsername = result.username;
      } catch (err) {
        set.status = 502;
        return { error: `Last.fm auth failed: ${(err as Error).message}` };
      }

      await store.upsert({
        ...user,
        lastfmSessionKey: sessionKey,
        lastfmUsername,
      });

      console.log(`[scrobbler] ${user.tachiUsername} → linked Last.fm: ${lastfmUsername}`);
      redirect()
    });
}