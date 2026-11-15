import { parseEncryptionKey } from './crypto.ts';

export type Config = {
  port: number;
  /** Meta app secret. Keys the signature on every webhook delivery. */
  metaAppSecret: string;
  /** Shared string Meta echoes back during the webhook verification handshake. */
  metaVerifyToken: string;
  /** Directory for verbatim webhook bodies, or null to not capture. Local dev only. */
  captureDir: string | null;
  /** The SongSnag account's Instagram handle, without the @. Shown on the public pages. */
  igHandle: string | null;
  /** Address shown on the public pages for privacy and deletion requests. */
  contactEmail: string | null;
  /**
   * Everything the reel-to-playlist service needs, or null when part of it is
   * not configured. Without it the server still verifies and logs webhooks
   * and serves the website, but answers nobody.
   */
  service: ServiceConfig | null;
  /** The variables that are keeping `service` null. */
  serviceMissing: string[];
};

export type ServiceConfig = {
  /** Token the SongSnag account's DMs are sent with. */
  igAccessToken: string;
  /** The SongSnag professional account's ID. */
  igAccountId: string;
  spotifyClientId: string;
  spotifyClientSecret: string;
  /** Public base URL of this server, no trailing slash. */
  baseUrl: string;
  /** 32-byte key that encrypts Spotify tokens in the database. */
  tokenEncryptionKey: Buffer;
  anthropicApiKey: string;
  /** Without it, the speech in a reel is not read. */
  openaiApiKey: string | null;
  /** The SQLite file. */
  databasePath: string;
};

const SERVICE_VARIABLES = [
  'IG_ACCESS_TOKEN',
  'IG_ACCOUNT_ID',
  'SPOTIFY_CLIENT_ID',
  'SPOTIFY_CLIENT_SECRET',
  'BASE_URL',
  'TOKEN_ENCRYPTION_KEY',
  'ANTHROPIC_API_KEY',
] as const;

export class ConfigError extends Error {}

type Env = Record<string, string | undefined>;

function read(env: Env, name: string): string | null {
  const value = env[name]?.trim();
  return value ? value : null;
}

/**
 * Reads and validates configuration from environment variables.
 *
 * The two webhook variables are required. The service variables are needed
 * together: with any of them missing the service stays off (see `service`).
 */
export function loadConfig(env: Env = process.env): Config {
  const missing: string[] = [];
  const required = (name: string): string => {
    const value = read(env, name);
    if (value === null) missing.push(name);
    return value ?? '';
  };

  const metaAppSecret = required('META_APP_SECRET');
  const metaVerifyToken = required('META_VERIFY_TOKEN');
  if (missing.length > 0) {
    throw new ConfigError(
      `Missing required environment variables: ${missing.join(', ')}. See .env.example.`,
    );
  }

  const portText = read(env, 'PORT') ?? '3000';
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`PORT must be an integer between 1 and 65535, got "${portText}".`);
  }

  const serviceMissing = SERVICE_VARIABLES.filter((name) => read(env, name) === null);
  let service: ServiceConfig | null = null;
  if (serviceMissing.length === 0) {
    const value = (name: (typeof SERVICE_VARIABLES)[number]) => read(env, name)!;

    const baseUrl = value('BASE_URL').replace(/\/+$/, '');
    if (!/^https?:\/\/[^/\s]+$/.test(baseUrl)) {
      throw new ConfigError('BASE_URL must look like https://api.songsnag.com, with no path.');
    }
    const tokenEncryptionKey = parseEncryptionKey(value('TOKEN_ENCRYPTION_KEY'));
    if (tokenEncryptionKey === null) {
      throw new ConfigError(
        'TOKEN_ENCRYPTION_KEY must be 32 bytes in base64. Generate one with: openssl rand -base64 32',
      );
    }
    service = {
      igAccessToken: value('IG_ACCESS_TOKEN'),
      igAccountId: value('IG_ACCOUNT_ID'),
      spotifyClientId: value('SPOTIFY_CLIENT_ID'),
      spotifyClientSecret: value('SPOTIFY_CLIENT_SECRET'),
      baseUrl,
      tokenEncryptionKey,
      anthropicApiKey: value('ANTHROPIC_API_KEY'),
      openaiApiKey: read(env, 'OPENAI_API_KEY'),
      databasePath: read(env, 'DATABASE_PATH') ?? 'data/songsnag.db',
    };
  }

  return {
    service,
    serviceMissing: [...serviceMissing],
    port,
    metaAppSecret,
    metaVerifyToken,
    captureDir: read(env, 'CAPTURE_DIR'),
    igHandle: read(env, 'IG_HANDLE')?.replace(/^@/, '') ?? null,
    contactEmail: read(env, 'CONTACT_EMAIL'),
  };
}
