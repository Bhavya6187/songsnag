/**
 * Subscribes the Instagram account behind IG_ACCESS_TOKEN to `messages`
 * webhooks and prints the account ID to copy into .env.
 *
 *   npm run ig:subscribe
 *
 * Saving a callback URL in the App Dashboard is not enough on its own: each
 * professional account also has to be subscribed to the app, which is what
 * this does. Safe to run more than once.
 *
 * Written for the "Instagram API with Unified Login" setup, where the token is
 * a Business Integration System User Access Token and the host is
 * graph.facebook.com.
 */

const GRAPH_URL = 'https://graph.facebook.com/v27.0';

const token = process.env.IG_ACCESS_TOKEN?.trim();
if (!token) {
  console.error('IG_ACCESS_TOKEN is not set. See .env.example.');
  process.exit(1);
}

type Account = { id: string; username: string | null };

async function graph(
  method: 'GET' | 'POST',
  path: string,
  params: Record<string, string> = {},
): Promise<unknown> {
  const url = new URL(`${GRAPH_URL}${path}`);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);

  // The token goes in a header rather than the URL so it stays out of logs.
  const response = await fetch(url, { method, headers: { Authorization: `Bearer ${token}` } });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`${method} ${path} failed with HTTP ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The Instagram professional accounts this token was given access to. */
async function listAccounts(): Promise<Account[]> {
  const body = await graph('GET', '/me/assigned_instagram_accounts', { fields: 'id,username' });
  const rows = isRecord(body) && Array.isArray(body.data) ? body.data : [];
  return rows.flatMap((row): Account[] =>
    isRecord(row) && typeof row.id === 'string'
      ? [{ id: row.id, username: typeof row.username === 'string' ? row.username : null }]
      : [],
  );
}

function chooseAccount(accounts: Account[], wantedId: string | undefined): Account {
  const describe = (account: Account) => `${account.id} (@${account.username ?? 'unknown'})`;
  if (accounts.length === 0) {
    throw new Error('The token has no Instagram accounts assigned to it.');
  }
  if (wantedId) {
    const match = accounts.find((account) => account.id === wantedId);
    if (!match) {
      throw new Error(
        `IG_ACCOUNT_ID=${wantedId} is not one of this token's accounts: ${accounts.map(describe).join(', ')}`,
      );
    }
    return match;
  }
  if (accounts.length > 1) {
    throw new Error(
      `The token covers several accounts. Set IG_ACCOUNT_ID to one of: ${accounts.map(describe).join(', ')}`,
    );
  }
  return accounts[0]!;
}

try {
  const account = chooseAccount(await listAccounts(), process.env.IG_ACCOUNT_ID?.trim());
  console.log(`Account: @${account.username ?? 'unknown'}`);
  console.log(`IG_ACCOUNT_ID=${account.id}`);

  const subscribed = await graph('POST', `/${account.id}/subscribed_apps`, {
    subscribed_fields: 'messages',
  });
  console.log(`Subscribe to messages: ${JSON.stringify(subscribed)}`);

  const current = await graph('GET', `/${account.id}/subscribed_apps`);
  console.log(`Current subscriptions: ${JSON.stringify(current)}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
