const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES_PER_CONVERSATION = 100;
const MAX_CONVERSATIONS = 1000;

export interface DownloadCodeCacheEntry {
    downloadCode: string;
    msgType: string;
    createdAt: number;
    expiresAt: number;
    spaceId?: string;
    fileId?: string;
}

interface ConversationBucket {
    entries: Map<string, DownloadCodeCacheEntry>;
    lastActiveAt: number;
}

const store = new Map<string, ConversationBucket>();

function getBucket(conversationId: string): ConversationBucket | undefined {
    return store.get(conversationId);
}

function getOrCreateBucket(conversationId: string): ConversationBucket {
    let bucket = store.get(conversationId);
    if (!bucket) {
        bucket = { entries: new Map(), lastActiveAt: Date.now() };
        store.set(conversationId, bucket);
        evictConversationsIfNeeded();
    }
    bucket.lastActiveAt = Date.now();
    return bucket;
}

function evictConversationsIfNeeded(): void {
    if (store.size <= MAX_CONVERSATIONS) {
        return;
    }
    let oldestKey: string | undefined;
    let oldestTime = Infinity;
    for (const [key, bucket] of store) {
        if (bucket.lastActiveAt < oldestTime) {
            oldestTime = bucket.lastActiveAt;
            oldestKey = key;
        }
    }
    if (oldestKey) {
        store.delete(oldestKey);
    }
}

function evictEntriesIfNeeded(bucket: ConversationBucket): void {
    if (bucket.entries.size <= MAX_ENTRIES_PER_CONVERSATION) {
        return;
    }
    let oldestKey: string | undefined;
    let oldestTime = Infinity;
    for (const [key, entry] of bucket.entries) {
        if (entry.createdAt < oldestTime) {
            oldestTime = entry.createdAt;
            oldestKey = key;
        }
    }
    if (oldestKey) {
        bucket.entries.delete(oldestKey);
    }
}

function purgeExpiredEntries(bucket: ConversationBucket): void {
    const now = Date.now();
    for (const [key, entry] of bucket.entries) {
        if (now >= entry.expiresAt) {
            bucket.entries.delete(key);
        }
    }
}

export function cacheInboundDownloadCode(
    accountId: string,
    conversationId: string,
    msgId: string,
    downloadCode: string,
    msgType: string,
    createdAt: number,
    extra?: { spaceId?: string; fileId?: string },
): void {
    const scopedKey = `${accountId}:${conversationId}`;
    const bucket = getOrCreateBucket(scopedKey);
    purgeExpiredEntries(bucket);
    bucket.entries.set(msgId, {
        downloadCode,
        msgType,
        createdAt,
        expiresAt: Date.now() + DEFAULT_TTL_MS,
        spaceId: extra?.spaceId,
        fileId: extra?.fileId,
    });
    evictEntriesIfNeeded(bucket);
}

export function getCachedDownloadCode(
    accountId: string,
    conversationId: string,
    msgId: string,
): DownloadCodeCacheEntry | null {
    const scopedKey = `${accountId}:${conversationId}`;
    const bucket = getBucket(scopedKey);
    if (!bucket) {
        return null;
    }
    const entry = bucket.entries.get(msgId);
    if (!entry) {
        return null;
    }
    if (Date.now() >= entry.expiresAt) {
        bucket.entries.delete(msgId);
        return null;
    }
    bucket.lastActiveAt = Date.now();
    return entry;
}

export function clearQuotedMsgCacheForTest(): void {
    store.clear();
}
