/**
 * Deletes everything SongSnag holds about one person: their Spotify link and
 * tokens, their unused links, and the record of their reels. This is the
 * deletion the privacy policy promises.
 *
 *   npm run user:delete -- <IGSID>
 *
 * The IGSID is the `igsid` in the server's log lines for that person's
 * messages. Run it where the database is (on Railway: `railway ssh`, then
 * `node scripts/user-delete.ts <IGSID>`).
 */
import { loadConfig } from '../src/config.ts';
import { createTokenCipher } from '../src/crypto.ts';
import { openStore } from '../src/db.ts';

const igsid = process.argv[2]?.trim();
if (!igsid) {
  console.error('Usage: npm run user:delete -- <IGSID>');
  process.exit(1);
}

const { service, serviceMissing } = loadConfig();
if (service === null) {
  console.error(`The service is not configured. Missing: ${serviceMissing.join(', ')}`);
  process.exit(1);
}

const store = openStore(service.databasePath, createTokenCipher(service.tokenEncryptionKey));
const removed = store.deleteUser(igsid);
store.close();
console.log(`Deleted for ${igsid}: ${removed.users} Spotify link, ${removed.links} link tokens, ${removed.reels} message records.`);
