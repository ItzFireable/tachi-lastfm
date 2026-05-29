import Elysia from "elysia";
import { IUserStore, createUserStore, tachiAuthUrl, tachiExchangeCode, lastfmAuthUrl, lastfmExchangeToken } from "./auth";
import { syncUser } from "./syncer";

export interface ScrobblerPluginConfig {
  redirectUri: string;

  tachiClientId: string;
  tachiClientSecret: string;

  tachiRedirectUri: string;
  tachiApiBaseUrl: string;
  tachiWebBaseUrl: string;

  lastfmApiKey: string;
  lastfmApiSecret: string;
  lastfmCallbackUrl: string;

  intervalMs?: number;

  sqlConnectionString?: string;
  storageFile?: string;
}

export function tachiScrobblerPlugin(config: ScrobblerPluginConfig) {
  const intervalMs = config.intervalMs ?? 5 * 60 * 1000;

  const store: IUserStore = createUserStore({
    sqlConnectionString: config.sqlConnectionString,
    storageFile: config.storageFile,
  });

  const pendingLastfm = new Map<number, number>();

  async function syncAll() {
    const users = (await store.getAll()).filter((u) => u.lastfmSessionKey);
    if (users.length === 0) return;

    await Promise.allSettled(
      users.map(async (user) => {
        try {
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
          }
          await store.updateSyncState(user.tachiUserId, result.newState.lastSyncedAt);
        } catch (err) {
          console.error(`[scrobbler] Error syncing ${user.tachiUsername}:`, err);
        }
      })
    );
  }

  store.load().then(async () => {
    const all = await store.getAll();
    console.log(`[scrobbler] Loaded ${all.length} user(s). Interval: ${intervalMs / 1000}s`);
    syncAll();
    setInterval(syncAll, intervalMs);
  });

  return new Elysia({ prefix: "/scrobbler" })
    .get("/status", async () => {
      const users = (await store.getAll()).map((u) => ({
        tachiUsername: u.tachiUsername,
        lastfmUsername: u.lastfmUsername ?? null,
        connected: !!u.lastfmSessionKey,
        syncing: u.syncing,
        lastSyncedAt: u.lastSyncedAt,
      }));
      return { ok: true, users };
    })

    .get("/status/:id", async ({ query, set }) => {
      const uuid = query.uuid as string | undefined;
      if (!uuid) {
        set.status = 400;
        return { error: "Missing UUID parameter" };
      }

      const existing = await store.getByUUID(uuid);
      if (!existing) {
        set.status = 400;
        return { error: "Invalid user" };
      }

      const user = {
        tachiUsername: existing.tachiUsername,
        lastfmUsername: existing.lastfmUsername ?? null,
        connected: !!existing.lastfmSessionKey,
        syncing: existing.syncing,
        lastSyncedAt: existing.lastSyncedAt,
      };

      return user;
    })

    .get("/connect/tachi", ({ redirect }) => {
      const url = tachiAuthUrl(config.tachiClientId, config.tachiWebBaseUrl);
      return redirect(url)
    })

    .get("/disconnect", async ({ query, set, redirect }) => {
      const uuid = query.uuid as string | undefined;
      if (!uuid) {
        set.status = 400;
        return { error: "Missing UUID parameter" };
      }

      const existing = await store.getByUUID(uuid);
      if (existing) {
        await store.removeByUUID(uuid);
      } else {
        set.status = 400;
        return { error: "Invalid user" };
      }

      return redirect(`${config.redirectUri}`);
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

      const existing = await store.get(tachiUserId);
      await store.upsert({
        tachiUserId,
        tachiUsername,
        tachiToken,
        lastfmSessionKey: existing?.lastfmSessionKey,
        lastfmUsername: existing?.lastfmUsername,
        lastSyncedAt: existing?.lastSyncedAt ?? 0,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        serverUUID: existing?.serverUUID ?? crypto.randomUUID(),
        syncing: existing?.syncing ?? true,
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

      const user = await store.get(tachiId);
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
      const sp   = new URLSearchParams({
        uuid: user.serverUUID,
      })
      return redirect(`${config.redirectUri}?${sp.toString()}`);
    });
}
