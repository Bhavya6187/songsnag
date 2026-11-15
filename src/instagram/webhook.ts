/**
 * Parsing for Instagram messaging webhooks.
 *
 * The shapes handled here follow Meta's webhook docs as read in November 2026.
 * They have not been checked against a real delivery yet. The app uses the
 * "Instagram API with Unified Login" setup, whose webhooks Meta describes as
 * following the "Facebook Login for Business" format.
 * Nothing in this file throws on unexpected input: anything it does not
 * recognize comes back as an `ignored` event so the caller can log it.
 */

/** Attachment types for a shared reel: `ig_reel` is an Instagram reel, `reel` a Facebook one. */
const REEL_ATTACHMENT_TYPES = new Set(['ig_reel', 'reel']);

export type Reel = {
  attachmentType: string;
  /** Video URL on Meta's CDN. Signed and assumed short-lived: fetch it right away. */
  url: string;
  /** The reel's caption, if it has one. */
  title: string | null;
  /** `reel_video_id`, as a string so IDs longer than 16 digits stay exact. */
  videoId: string | null;
};

type MessageBase = {
  /** The professional account the webhook was delivered for (`entry.id`). */
  accountId: string | null;
  /** Instagram-scoped ID of the person in the conversation. Replies are addressed to it. */
  igsid: string;
  /** Message ID. Meta retries deliveries, so this is the idempotency key. */
  mid: string;
  /** When the message was sent, in milliseconds since the epoch. */
  timestamp: number | null;
  /**
   * True when the account messaged itself, which is Meta's way to test without
   * a second account. Messages the bot sends in such a conversation may come
   * back flagged the same way, so never answer a self message that is not a reel.
   */
  isSelf: boolean;
};

export type IgnoredReason =
  | 'echo'
  | 'deleted'
  | 'read'
  | 'reaction'
  | 'postback'
  | 'referral'
  | 'edit'
  | 'no_message_id'
  | 'no_sender'
  | 'unrecognized';

export type InboundEvent =
  | (MessageBase & { kind: 'reel'; reel: Reel })
  | (MessageBase & { kind: 'unsupported'; reason: 'flagged_unsupported' | 'reel_without_url' })
  | (MessageBase & { kind: 'message'; text: string | null; attachmentTypes: string[] })
  | { kind: 'ignored'; reason: IgnoredReason; accountId: string | null; mid: string | null };

export type ParsedWebhook = {
  /** The payload's `object` field. Only `instagram` payloads produce events. */
  object: string | null;
  events: InboundEvent[];
};

/**
 * `JSON.parse`, except that integers too large for a JavaScript number come
 * back as strings holding their exact digits. Instagram IDs run to 17 digits
 * and Meta documents some of them (`reel_video_id`) as JSON numbers, which
 * plain `JSON.parse` would silently round.
 */
export function parseJsonKeepingBigIntegers(text: string): unknown {
  return JSON.parse(text, (_key: string, value: unknown, context?: { source?: string }) => {
    if (
      typeof value === 'number' &&
      !Number.isSafeInteger(value) &&
      context?.source !== undefined &&
      /^-?\d+$/.test(context.source)
    ) {
      return context.source;
    }
    return value;
  });
}

export function parseWebhook(payload: unknown): ParsedWebhook {
  if (!isRecord(payload)) return { object: null, events: [] };
  const object = typeof payload.object === 'string' ? payload.object : null;
  if (object !== 'instagram') return { object, events: [] };

  const events: InboundEvent[] = [];
  for (const entry of asArray(payload.entry)) {
    if (!isRecord(entry)) continue;
    const accountId = toId(entry.id);

    for (const item of asArray(entry.messaging)) {
      events.push(parseMessagingItem(item, accountId));
    }
    // The App Dashboard's "Test" button wraps the same messaging object as
    // { field: "messages", value: { ... } } instead of using `messaging`.
    for (const change of asArray(entry.changes)) {
      events.push(parseMessagingItem(isRecord(change) ? change.value : null, accountId));
    }
  }
  return { object, events };
}

function parseMessagingItem(item: unknown, accountId: string | null): InboundEvent {
  const ignored = (reason: IgnoredReason, mid: string | null = null): InboundEvent => ({
    kind: 'ignored',
    reason,
    accountId,
    mid,
  });
  if (!isRecord(item)) return ignored('unrecognized');

  const message = item.message;
  if (!isRecord(message)) {
    if (isRecord(item.read)) return ignored('read', toId(item.read.mid));
    if (isRecord(item.reaction)) return ignored('reaction', toId(item.reaction.mid));
    if (isRecord(item.postback)) return ignored('postback', toId(item.postback.mid));
    if (isRecord(item.message_edit)) return ignored('edit', toId(item.message_edit.mid));
    if (isRecord(item.referral)) return ignored('referral');
    return ignored('unrecognized');
  }

  const mid = toId(message.mid);
  const isSelf = message.is_self === true;
  // Echoes are copies of messages the account itself sent, including the
  // bot's own replies. A self message is also delivered as an echo.
  if (message.is_echo === true && !isSelf) return ignored('echo', mid);
  if (message.is_deleted === true) return ignored('deleted', mid);
  if (mid === null) return ignored('no_message_id');

  const senderId = isRecord(item.sender) ? toId(item.sender.id) : null;
  const recipientId = isRecord(item.recipient) ? toId(item.recipient.id) : null;
  // In a self message the account is the sender, and its Instagram-scoped ID
  // (the one replies must be addressed to) is in `recipient`.
  const igsid = isSelf ? recipientId : senderId;
  if (igsid === null) return ignored('no_sender', mid);

  const base: MessageBase = {
    accountId,
    igsid,
    mid,
    timestamp: toTimestamp(item.timestamp),
    isSelf,
  };
  const attachments = asArray(message.attachments).filter(isRecord);

  const reelAttachment = attachments.find(
    (attachment) =>
      typeof attachment.type === 'string' && REEL_ATTACHMENT_TYPES.has(attachment.type),
  );
  if (reelAttachment) {
    const payload = isRecord(reelAttachment.payload) ? reelAttachment.payload : {};
    const url = toNonEmptyString(payload.url);
    if (url === null) return { ...base, kind: 'unsupported', reason: 'reel_without_url' };
    return {
      ...base,
      kind: 'reel',
      reel: {
        attachmentType: String(reelAttachment.type),
        url,
        title: toNonEmptyString(payload.title),
        videoId: toId(payload.reel_video_id),
      },
    };
  }

  if (message.is_unsupported === true) {
    return { ...base, kind: 'unsupported', reason: 'flagged_unsupported' };
  }

  return {
    ...base,
    kind: 'message',
    text: typeof message.text === 'string' ? message.text : null,
    attachmentTypes: attachments.map((attachment) =>
      typeof attachment.type === 'string' ? attachment.type : 'unknown',
    ),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function toNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** IDs arrive as strings or as numbers depending on the field. Normalize to a string. */
function toId(value: unknown): string | null {
  if (typeof value === 'string') return value !== '' ? value : null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/** Timestamps are numbers in real deliveries and strings in the dashboard's test payload. */
function toTimestamp(value: unknown): number | null {
  const parsed = typeof value === 'string' && value !== '' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
}
