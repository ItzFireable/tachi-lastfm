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

export interface IUserStore {
  load(): Promise<void>;
  save(): Promise<void>;
  get(tachiUserId: number): Promise<UserRecord | undefined>;
  getByUUID(uuid: string): Promise<UserRecord | undefined>;
  getAll(): Promise<UserRecord[]>;
  removeByUUID(uuid: string): Promise<boolean>;
  upsert(record: UserRecord): Promise<void>;
  updateSyncState(tachiUserId: number, lastSyncedAt: number): Promise<void>;
}

export class UserStore implements IUserStore {
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

  async get(tachiUserId: number): Promise<UserRecord | undefined> {
    return this.users.get(tachiUserId);
  }

  async getByUUID(uuid: string): Promise<UserRecord | undefined> {
    return Array.from(this.users.values()).find((u) => u.serverUUID === uuid);
  }

  async getAll(): Promise<UserRecord[]> {
    return [...this.users.values()];
  }

  async removeByUUID(uuid: string): Promise<boolean> {
    const user = await this.getByUUID(uuid);
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

function parseBlobConnectionString(cs: string): {
  accountName: string;
  accountKey: string;
  endpointSuffix: string;
} {
  const get = (key: string) => {
    const match = cs.match(new RegExp(`${key}=([^;]+)`));
    if (!match) throw new Error(`BlobUserStore: missing ${key} in connection string`);
    return match[1];
  };
  return {
    accountName:    get("AccountName"),
    accountKey:     get("AccountKey"),
    endpointSuffix: get("EndpointSuffix") ?? "core.windows.net",
  };
}

async function blobSharedKeyHeaders(
  accountName: string,
  accountKey: string,
  method: string,
  containerName: string,
  blobName: string,
  body?: string
): Promise<Record<string, string>> {
  const dateStr     = new Date().toUTCString();
  const contentType = body !== undefined ? "application/json" : "";
  const contentLen  = body !== undefined ? String(Buffer.byteLength(body, "utf-8")) : "";

  const stringToSign = [
    method.toUpperCase(),
    "",           // Content-Encoding
    "",           // Content-Language
    contentLen,
    "",           // Content-MD5
    contentType,
    "",           // Date (empty — using x-ms-date instead)
    "", "", "", "", // If-* headers
    "",           // Range
    `x-ms-blob-type:BlockBlob\nx-ms-date:${dateStr}\nx-ms-version:2020-04-08`,
    `/${accountName}/${containerName}/${blobName}`,
  ].join("\n");

  const keyBytes = Buffer.from(accountKey, "base64");
  const cryptoKey = await crypto.subtle.importKey(
    "raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = Buffer.from(
    await crypto.subtle.sign("HMAC", cryptoKey, Buffer.from(stringToSign, "utf-8"))
  ).toString("base64");

  const headers: Record<string, string> = {
    "x-ms-date":      dateStr,
    "x-ms-version":   "2020-04-08",
    "x-ms-blob-type": "BlockBlob",
    "Authorization":  `SharedKey ${accountName}:${sig}`,
  };
  if (body !== undefined) {
    headers["Content-Type"]   = contentType;
    headers["Content-Length"] = contentLen;
  }
  return headers;
}

export class BlobUserStore implements IUserStore {
  private users: Map<number, UserRecord> = new Map();
  private readonly accountName: string;
  private readonly accountKey: string;
  private readonly endpointSuffix: string;
  private readonly containerName: string;
  private readonly blobName: string;

  constructor(connectionString: string, containerName = "scrobbler", blobName = "users.json") {
    const parsed        = parseBlobConnectionString(connectionString);
    this.accountName    = parsed.accountName;
    this.accountKey     = parsed.accountKey;
    this.endpointSuffix = parsed.endpointSuffix;
    this.containerName  = containerName;
    this.blobName       = blobName;
  }

  private get blobUrl(): string {
    return `https://${this.accountName}.blob.${this.endpointSuffix}/${this.containerName}/${this.blobName}`;
  }

  async load(): Promise<void> {
    const res = await fetch(this.blobUrl, {
      method: "GET",
      headers: await blobSharedKeyHeaders(this.accountName, this.accountKey, "GET", this.containerName, this.blobName),
    });
    if (res.status === 404) { this.users = new Map(); return; }
    if (!res.ok) throw new Error(`Blob GET failed: ${res.status} ${await res.text()}`);
    const arr = (await res.json()) as UserRecord[];
    this.users = new Map(arr.map((u) => [u.tachiUserId, u]));
  }

  async save(): Promise<void> {
    const body = JSON.stringify([...this.users.values()], null, 2);
    const res = await fetch(this.blobUrl, {
      method: "PUT",
      headers: await blobSharedKeyHeaders(this.accountName, this.accountKey, "PUT", this.containerName, this.blobName, body),
      body,
    });
    if (!res.ok) throw new Error(`Blob PUT failed: ${res.status} ${await res.text()}`);
  }

  async get(tachiUserId: number): Promise<UserRecord | undefined> {
    return this.users.get(tachiUserId);
  }

  async getByUUID(uuid: string): Promise<UserRecord | undefined> {
    return Array.from(this.users.values()).find((u) => u.serverUUID === uuid);
  }

  async getAll(): Promise<UserRecord[]> {
    return [...this.users.values()];
  }

  async removeByUUID(uuid: string): Promise<boolean> {
    const user = await this.getByUUID(uuid);
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

export interface CreateUserStoreOptions {
  blobConnectionString?: string;
  blobContainerName?: string;
  blobName?: string;
  storageFile?: string;
}

export function createUserStore(options: CreateUserStoreOptions): IUserStore {
  if (options.blobConnectionString) {
    const container = options.blobContainerName ?? "scrobbler";
    const blob      = options.blobName          ?? "users.json";
    console.log(`[scrobbler] Azure Blob connection string found — using BlobUserStore (${container}/${blob})`);
    return new BlobUserStore(options.blobConnectionString, container, blob);
  }
  const file = options.storageFile ?? ".scrobbler-users.json";
  console.log(`[scrobbler] No Blob connection string — falling back to file store (${file})`);
  return new UserStore(file);
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
