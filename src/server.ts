import { serve } from '@hono/node-server';
import Anthropic from '@anthropic-ai/sdk';
import { createApp, type Service } from './app.ts';
import { ConfigError, loadConfig, type Config, type ServiceConfig } from './config.ts';
import { createTokenCipher } from './crypto.ts';
import { openStore } from './db.ts';
import { createSender } from './instagram/send.ts';
import { log } from './log.ts';
import { createPipeline } from './pipeline.ts';
import { recognizeReel } from './recognize/reel.ts';
import { extractSongs } from './recognize/songs.ts';
import { createSpotify } from './spotify/client.ts';

let config: Config;
try {
  config = loadConfig();
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(error.message);
  process.exit(1);
}

const service = config.service === null ? null : startService(config.service);
if (service === null) {
  log.warn('service is off: webhooks are logged but nobody is answered', { missing: config.serviceMissing });
}

const app = createApp({ config, log, service });

serve({ fetch: app.fetch, port: config.port }, (info) => {
  log.info('SongSnag listening', {
    port: info.port,
    captureDir: config.captureDir,
    service: service !== null,
  });
  service?.pipeline.recover();
});

function startService(settings: ServiceConfig): Service {
  const store = openStore(settings.databasePath, createTokenCipher(settings.tokenEncryptionKey));
  const spotify = createSpotify({
    clientId: settings.spotifyClientId,
    clientSecret: settings.spotifyClientSecret,
    redirectUri: `${settings.baseUrl}/auth/spotify/callback`,
  });
  const anthropic = new Anthropic({ apiKey: settings.anthropicApiKey });
  const pipeline = createPipeline({
    store,
    spotify,
    log,
    baseUrl: settings.baseUrl,
    send: createSender({ accountId: settings.igAccountId, accessToken: settings.igAccessToken }),
    recognize: (reel) =>
      recognizeReel(reel, {
        openaiApiKey: settings.openaiApiKey,
        steps: { extractSongs: (evidence) => extractSongs(evidence, anthropic) },
      }),
  });
  return { store, spotify, pipeline };
}
