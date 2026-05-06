import * as crypto from "crypto";
import { readFile, writeFile } from "fs/promises";

export interface UserRecord {
  tachiUserId: number;
  tachiUsername: string;
  tachiToken: string;
  lastfmSessionKey?: string;
  lastfmUsername?: string;
  lastSyncedAt: number;
  createdAt: string;
  serverUUID: string;
  syncing: boolean;
}

export class UserStore {
  private users: Map<number, UserRecord> = new Map();
  private path: string;

  constructor(path: string) {
    this.path = path;
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.path, "utf8");
      const arr = JSON.parse(raw) as UserRecord[];
      this.users = new Map(arr.map((u) => [u.tachiUserId, u]));
    } catch {
      this.users = new Map();
    }
  }

  async save(): Promise<void> {
    await writeFile(
      this.path,
      JSON.stringify([...this.users.values()], null, 2),
      "utf8"
    );
  }

  get(tachiUserId: number): UserRecord | undefined {
    return this.users.get(tachiUserId);
  }

  getByUUID(uuid: string): UserRecord | undefined {
    return Array.from(this.users.values()).find((u) => u.serverUUID === uuid);
  }

  getAll(): UserRecord[] {
    return [...this.users.values()];
  }

  async removeByUUID(uuid: string): Promise<boolean> {
    const user = this.getByUUID(uuid);
    if (user) {
      this.users.delete(user.tachiUserId);
      await this.save();
      return true;
    }
    return false;
  }

  async upsert(record: UserRecord): Promise<void> {
    this.users.set(record.tachiUserId, record);
    await this.save();
  }

  async updateSyncState(tachiUserId: number, lastSyncedAt: number): Promise<void> {
    const user = this.users.get(tachiUserId);
    if (!user) throw new Error(`Unknown user ${tachiUserId}`);
    user.lastSyncedAt = lastSyncedAt;
    await this.save();
  }
}

export interface TachiOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  baseUrl: string;
}

export function tachiAuthUrl(clientId: string, tachiClientBaseUrl: string): string {
  return `${tachiClientBaseUrl}/oauth/request-auth?clientID=${clientId}`;
}

export async function tachiExchangeCode(
  code: string,
  config: TachiOAuthConfig
): Promise<{ token: string; tachiUserId: number; tachiUsername: string }> {
  const tokenRes = await fetch(`${config.baseUrl}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: "authorization_code",
      redirect_uri: config.redirectUri,
      code,
    }),
  });

  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    throw new Error(`Tachi token exchange failed (${tokenRes.status}): ${text}`);
  }

  const tokenData = (await tokenRes.json()) as {
    success: boolean;
    description: string;
    body: { token: string; userID: number };
  };

  if (!tokenData.success) {
    throw new Error(`Tachi token exchange error: ${tokenData.description}`);
  }

  const { token, userID } = tokenData.body;
  const meRes = await fetch(`${config.baseUrl}/users/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const meData = (await meRes.json()) as {
    success: boolean;
    body: { id: number; username: string };
  };

  return {
    token,
    tachiUserId: meData.body.id,
    tachiUsername: meData.body.username,
  };
}

export interface LastfmAuthConfig {
  apiKey: string;
  apiSecret: string;
  callbackUrl: string;
}

export function lastfmAuthUrl(config: Pick<LastfmAuthConfig, "apiKey" | "callbackUrl">): string {
  return `https://www.last.fm/api/auth/?api_key=${config.apiKey}&cb=${encodeURIComponent(config.callbackUrl)}`;
}

export async function lastfmExchangeToken(
  token: string,
  config: Pick<LastfmAuthConfig, "apiKey" | "apiSecret">
): Promise<{ sessionKey: string; username: string }> {
  const params: Record<string, string> = {
    api_key: config.apiKey,
    method: "auth.getSession",
    token,
  };
  const sigInput = Object.keys(params).sort().map((k) => `${k}${params[k]}`).join("");
  const api_sig = crypto.createHash("md5").update(sigInput + config.apiSecret, "utf8").digest("hex");

  const res = await fetch("https://ws.audioscrobbler.com/2.0/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...params, api_sig, format: "json" }).toString(),
  });

  const data = (await res.json()) as {
    session?: { key: string; name: string };
    error?: number;
    message?: string;
  };

  if (data.error) {
    throw new Error(`Last.fm auth error ${data.error}: ${data.message}`);
  }

  return {
    sessionKey: data.session!.key,
    username: data.session!.name,
  };
}
