import * as crypto from "crypto";
import { readFile, writeFile } from "fs/promises";
import sql from "mssql";

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

const CREATE_TABLE_SQL = `
IF NOT EXISTS (
  SELECT * FROM sysobjects WHERE name='scrobbler_users' AND xtype='U'
)
CREATE TABLE scrobbler_users (
  tachi_user_id      INT            NOT NULL PRIMARY KEY,
  tachi_username     NVARCHAR(255)  NOT NULL,
  tachi_token        NVARCHAR(2000) NOT NULL,
  lastfm_session_key NVARCHAR(255)  NULL,
  lastfm_username    NVARCHAR(255)  NULL,
  last_synced_at     BIGINT         NOT NULL DEFAULT 0,
  created_at         NVARCHAR(50)   NOT NULL,
  server_uuid        NVARCHAR(36)   NOT NULL,
  syncing            BIT            NOT NULL DEFAULT 1
);
`;

function rowToRecord(row: Record<string, unknown>): UserRecord {
  return {
    tachiUserId:      row.tachi_user_id as number,
    tachiUsername:    row.tachi_username as string,
    tachiToken:       row.tachi_token as string,
    lastfmSessionKey: (row.lastfm_session_key as string | null) ?? undefined,
    lastfmUsername:   (row.lastfm_username as string | null) ?? undefined,
    lastSyncedAt:     Number(row.last_synced_at),
    createdAt:        row.created_at as string,
    serverUUID:       row.server_uuid as string,
    syncing:          row.syncing === true || row.syncing === 1,
  };
}

export class SqlUserStore implements IUserStore {
  private pool: sql.ConnectionPool | null = null;
  private readonly connectionString: string;

  constructor(connectionString: string) {
    this.connectionString = connectionString;
  }

  async load(): Promise<void> {
    this.pool = await sql.connect(this.connectionString);
    await this.pool.request().query(CREATE_TABLE_SQL);
    console.log("[scrobbler] Connected to Azure SQL — scrobbler_users table ready");
  }

  /** No-op: SQL writes are committed immediately in each method. */
  async save(): Promise<void> {}

  private get db(): sql.ConnectionPool {
    if (!this.pool) throw new Error("[scrobbler] SqlUserStore.load() has not been called");
    return this.pool;
  }

  async get(tachiUserId: number): Promise<UserRecord | undefined> {
    const result = await this.db
      .request()
      .input("id", sql.Int, tachiUserId)
      .query("SELECT * FROM scrobbler_users WHERE tachi_user_id = @id");
    if (!result.recordset.length) return undefined;
    return rowToRecord(result.recordset[0]);
  }

  async getByUUID(uuid: string): Promise<UserRecord | undefined> {
    const result = await this.db
      .request()
      .input("uuid", sql.NVarChar(36), uuid)
      .query("SELECT * FROM scrobbler_users WHERE server_uuid = @uuid");
    if (!result.recordset.length) return undefined;
    return rowToRecord(result.recordset[0]);
  }

  async getAll(): Promise<UserRecord[]> {
    const result = await this.db
      .request()
      .query("SELECT * FROM scrobbler_users");
    return result.recordset.map(rowToRecord);
  }

  async removeByUUID(uuid: string): Promise<boolean> {
    const result = await this.db
      .request()
      .input("uuid", sql.NVarChar(36), uuid)
      .query("DELETE FROM scrobbler_users WHERE server_uuid = @uuid");
    return (result.rowsAffected[0] ?? 0) > 0;
  }

  async upsert(record: UserRecord): Promise<void> {
    await this.db
      .request()
      .input("tachiUserId",      sql.Int,           record.tachiUserId)
      .input("tachiUsername",    sql.NVarChar(255),  record.tachiUsername)
      .input("tachiToken",       sql.NVarChar(2000), record.tachiToken)
      .input("lastfmSessionKey", sql.NVarChar(255),  record.lastfmSessionKey ?? null)
      .input("lastfmUsername",   sql.NVarChar(255),  record.lastfmUsername ?? null)
      .input("lastSyncedAt",     sql.BigInt,         record.lastSyncedAt)
      .input("createdAt",        sql.NVarChar(50),   record.createdAt)
      .input("serverUUID",       sql.NVarChar(36),   record.serverUUID)
      .input("syncing",          sql.Bit,            record.syncing ? 1 : 0)
      .query(`
        MERGE scrobbler_users AS target
        USING (SELECT @tachiUserId AS tachi_user_id) AS source
          ON  target.tachi_user_id = source.tachi_user_id
        WHEN MATCHED THEN UPDATE SET
          tachi_username     = @tachiUsername,
          tachi_token        = @tachiToken,
          lastfm_session_key = @lastfmSessionKey,
          lastfm_username    = @lastfmUsername,
          last_synced_at     = @lastSyncedAt,
          created_at         = @createdAt,
          server_uuid        = @serverUUID,
          syncing            = @syncing
        WHEN NOT MATCHED THEN INSERT (
          tachi_user_id, tachi_username, tachi_token,
          lastfm_session_key, lastfm_username,
          last_synced_at, created_at, server_uuid, syncing
        ) VALUES (
          @tachiUserId, @tachiUsername, @tachiToken,
          @lastfmSessionKey, @lastfmUsername,
          @lastSyncedAt, @createdAt, @serverUUID, @syncing
        );
      `);
  }

  async updateSyncState(tachiUserId: number, lastSyncedAt: number): Promise<void> {
    const result = await this.db
      .request()
      .input("id",           sql.Int,    tachiUserId)
      .input("lastSyncedAt", sql.BigInt, lastSyncedAt)
      .query("UPDATE scrobbler_users SET last_synced_at = @lastSyncedAt WHERE tachi_user_id = @id");
    if ((result.rowsAffected[0] ?? 0) === 0) {
      throw new Error(`Unknown user ${tachiUserId}`);
    }
  }
}

export interface CreateUserStoreOptions {
  sqlConnectionString?: string;
  storageFile?: string;
}

export function createUserStore(options: CreateUserStoreOptions): IUserStore {
  if (options.sqlConnectionString) {
    console.log("[scrobbler] Azure SQL connection string found — using SqlUserStore");
    return new SqlUserStore(options.sqlConnectionString);
  }
  const file = options.storageFile ?? ".scrobbler-users.json";
  console.log(`[scrobbler] No SQL connection string — falling back to file store (${file})`);
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
