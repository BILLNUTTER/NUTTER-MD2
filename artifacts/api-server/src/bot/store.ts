import type { WAMessage } from "@whiskeysockets/baileys";

export interface GroupSettings {
  groupId: string;
  antilink: boolean;
  antibadword: "off" | "delete" | "kick";
  customBadWords: string | null;
  antimention: boolean;
  antiDelete: boolean;
  mute: boolean;
  customPrefix: string | null;
  welcomeEnabled: boolean;
  welcomeMessage: string | null;
  autoReply: string | null;
}

export interface UserSettings {
  userId: string;
  isBanned: boolean;
}

export interface BotSettings {
  autoViewStatus: boolean;
  autoLikeStatus: boolean;
  statusLikeEmoji: string;
  autoRejectCall: boolean;
}

// ── Group store ────────────────────────────────────────────────────────────────
const groupStore = new Map<string, GroupSettings>();

export function getGroupSettings(groupId: string): GroupSettings | null {
  return groupStore.get(groupId) ?? null;
}

export function ensureGroupSettings(groupId: string): GroupSettings {
  if (!groupStore.has(groupId)) {
    groupStore.set(groupId, {
      groupId,
      // FIX: Default ALL protections to OFF so the bot doesn't start deleting
      // messages or kicking members in groups immediately after joining.
      // Admins must explicitly enable features with commands (.antilink on, etc).
      // Env vars can still force a default ON via ANTI_LINK=true etc.
      antilink:    process.env["ANTI_LINK"]      === "true",
      antibadword: (process.env["ANTI_BAD_WORD"] === "true" ? "delete" : "off") as "off" | "delete" | "kick",
      customBadWords: null,
      antimention: process.env["ANTI_MENTION"]   === "true",
      antiDelete:  process.env["ANTI_DELETE"]    === "true",
      mute: false,
      customPrefix: null,
      welcomeEnabled: false,
      welcomeMessage: null,
      autoReply: null,
    });
  }
  return groupStore.get(groupId)!;
}

export function updateGroupSettings(groupId: string, update: Partial<Omit<GroupSettings, "groupId">>): void {
  const existing = ensureGroupSettings(groupId);
  groupStore.set(groupId, { ...existing, ...update });
}

// ── User store ─────────────────────────────────────────────────────────────────
const userStore = new Map<string, UserSettings>();

export function getUserSettings(userId: string): UserSettings | null {
  return userStore.get(userId) ?? null;
}

export function setUserBanned(userId: string, isBanned: boolean): void {
  userStore.set(userId, { userId, isBanned });
}

// ── Bot-level settings ─────────────────────────────────────────────────────────
const botSettings: BotSettings = {
  autoViewStatus: process.env["AUTO_VIEW_STATUS"] !== "false",
  autoLikeStatus: process.env["AUTO_LIKE_STATUS"] !== "false",
  statusLikeEmoji: process.env["STATUS_LIKE_EMOJI"] || "❤️",
  autoRejectCall:  process.env["AUTO_REJECT_CALL"]  !== "false",
};

export function getBotSettings(): BotSettings {
  return { ...botSettings };
}

export function updateBotSettings(update: Partial<BotSettings>): void {
  Object.assign(botSettings, update);
}

// ── Volatile in-memory message cache (for antidelete) ─────────────────────────
const MSG_TTL = 5 * 60 * 1000; // 5 minutes
const MSG_MAX = 2000;

interface CacheEntry { msg: WAMessage; expireAt: number }
const msgCache = new Map<string, CacheEntry>();

export function cacheMessage(msg: WAMessage): void {
  const id = msg.key.id;
  if (!id) return;
  // FIX: Original code skipped fromMe messages, but we should cache them too
  // so antidelete can forward messages the bot itself sent (e.g. in groups).
  // The fromMe guard was overly restrictive — only skip protocol/stub messages.
  if (msgCache.size >= MSG_MAX) {
    const now = Date.now();
    for (const [k, v] of msgCache) {
      if (v.expireAt < now) msgCache.delete(k);
    }
  }
  msgCache.set(id, { msg, expireAt: Date.now() + MSG_TTL });
}

export function popCachedMessage(id: string): WAMessage | null {
  const entry = msgCache.get(id);
  if (!entry) return null;
  msgCache.delete(id);
  return entry.expireAt >= Date.now() ? entry.msg : null;
}

// ── LID ↔ JID mapping ─────────────────────────────────────────────────────────
const lidToJidMap = new Map<string, string>();

export function registerLidMapping(lidJid: string, realJid: string) {
  lidToJidMap.set(lidJid, realJid);
}

/**
 * Resolve a @lid JID to the actual @s.whatsapp.net JID.
 * Returns the original JID unchanged if no mapping is known yet.
 */
export function resolveLid(jid: string): string {
  if (!jid.endsWith("@lid")) return jid;
  return lidToJidMap.get(jid) ?? jid;
}

/**
 * Attempt to resolve a @lid JID using Baileys' internal signal repository,
 * which may already hold a LID↔phone-number mapping that hasn't reached us
 * yet via a contacts.upsert event. This is a synchronous, in-memory lookup —
 * no network round-trip — so it's safe to call on the hot path before
 * falling back to sending directly to the raw @lid JID.
 *
 * The exact shape of `signalRepository` has shifted across Baileys releases,
 * so every access here is optional-chained and wrapped in try/catch. If the
 * method isn't present in the installed version, this simply returns null
 * and the caller falls back to its existing behavior — it never throws.
 *
 * On a successful resolution, the mapping is also written into
 * lidToJidMap via registerLidMapping so subsequent resolveLid() calls for
 * the same JID hit the fast path without going through this lookup again.
 */
export function tryLiveResolveLid(sock: unknown, jid: string): string | null {
  if (!jid.endsWith("@lid")) return jid;
  try {
    const repo = (
      sock as {
        signalRepository?: {
          lidMapping?: {
            getPNForLID?: (lid: string) => string | undefined | null;
          };
        };
      }
    ).signalRepository?.lidMapping;

    const rawPn = repo?.getPNForLID?.(jid);
    if (!rawPn) return null;

    // getPNForLID may return a bare number or a full JID depending on version —
    // normalize to a full @s.whatsapp.net JID either way.
    const pnJid = rawPn.includes("@") ? rawPn : `${rawPn}@s.whatsapp.net`;

    registerLidMapping(jid, pnJid);
    return pnJid;
  } catch {
    // Baileys version doesn't expose this API surface — ignore and fall back.
    return null;
  }
}
