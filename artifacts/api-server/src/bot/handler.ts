import type { WASocket, WAMessage, WAMessageKey, proto } from "@whiskeysockets/baileys";
import type { GroupSettings } from "./store";
import { getGroupSettings, getUserSettings, getBotSettings, updateBotSettings, registerLidMapping, resolveLid, tryLiveResolveLid } from "./store";
import { logger } from "../lib/logger";
import { safeSend } from "./utils";

export { safeSend };
import {
  handlePing,
  handleAlive,
  handleMenu,
  handleOwner,
  handleSettings,
  handleSticker,
  handleRestart,
  handleRefreshSession,
} from "./commands/general";
import { handleFunCommand } from "./commands/fun";
import {
  handleKick,
  handleAdd,
  handlePromote,
  handleDemote,
  handleAntilink,
  handleAntibadword,
  handleAntimention,
  handleBan,
  handleUnban,
  handleSetPrefix,
  handleTagAll,
  handleGroupInfo,
  handleMute,
  handleUnmute,
  handleWelcome,
  handleSetWelcome,
  handleAutoReply,
  handleSetBadWords,
  handleAntiDelete,
  handleAntiEdit,
  handleAntiNudes,
} from "./commands/group";

const DEFAULT_BAD_WORDS = [
  "fuck", "shit", "bitch", "asshole", "nigga", "faggot", "cunt", "pussy",
  "whore", "slut", "dick", "cock", "prick", "wanker", "retard", "porn",
  "malaya", "kumbavu", "mkundu", "mpumbavu", "mshenzi", "shenzi", "nyoko", "mjinga",
];
const URL_REGEX = /\b(?:https?:\/\/|www\.|wa\.me\/|t\.me\/|chat\.whatsapp\.com\/|whatsapp\.com\/|telegram\.me\/|discord\.gg\/|discord\.com\/invite\/|instagram\.com\/|tiktok\.com\/|youtube\.com\/|youtu\.be\/|facebook\.com\/|x\.com\/|github\.com\/|bit\.ly\/|tinyurl\.com\/|(?:[a-z0-9-]+\.)+(?:com|net|org|co|io|me|app|dev|info|biz|xyz|site|online|ke|uk|us|gg|ly|tech|store|shop|cloud|ai|tv|live|club|link)(?:\/|\b))/i;
const linkViolations = new Map<string, { count: number; firstAt: number }>();
const badWordViolations = new Map<string, { count: number; firstAt: number }>();

function normalizeModerationWord(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u200b-\u200f\u202a-\u202e\ufeff]/g, "")
    .replace(/[013457@$!]/g, (char) => ({ "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s", "!": "i" })[char] ?? char)
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/(.)\1+/g, "$1")
    .trim();
}

function findBadWord(text: string, words: string[]) {
  const normalizedTokens = normalizeModerationWord(text)
    .split(/\s+/)
    .filter(Boolean);
  const compactTokens = normalizedTokens.map((token) => token.replace(/[^a-z0-9]/g, ""));
  for (const word of words) {
    const normalizedWord = normalizeModerationWord(word);
    if (!normalizedWord) continue;
    if (normalizedWord.includes(" ")) {
      if (normalizeModerationWord(text).includes(normalizedWord)) return word;
    } else if (compactTokens.includes(normalizedWord)) {
      return word;
    }
  }
  return null;
}
const GROUP_ADMIN_CONTEXT_COMMANDS = new Set([
  "kick", "add", "promote", "demote", "mute", "unmute",
  "antilink", "antibadword", "setbadwords", "antimention", "antidelete",
  "antiedit", "antinudes",
  "ban", "unban", "setprefix", "tagall", "welcome", "setwelcome", "autoreply",
]);

// ── Group metadata cache ───────────────────────────────────────────────────────
interface GroupMetaEntry {
  subject: string;
  participants: Array<{ id: string; admin?: "admin" | "superadmin" | null }>;
  expireAt: number;
}
const groupMetaCache = new Map<string, GroupMetaEntry>();
const GROUP_META_TTL     = 2 * 60 * 1000;
const GROUP_META_TIMEOUT = 5_000;

async function getCachedGroupMeta(sock: WASocket, jid: string): Promise<GroupMetaEntry> {
  const cached = groupMetaCache.get(jid);
  if (cached && cached.expireAt > Date.now()) return cached;
  let timeout: NodeJS.Timeout | undefined;
  let meta: Awaited<ReturnType<WASocket["groupMetadata"]>>;
  try {
    meta = await Promise.race([
      sock.groupMetadata(jid),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`groupMetadata timeout for ${jid}`)), GROUP_META_TIMEOUT);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  const entry: GroupMetaEntry = {
    subject: meta.subject,
    participants: meta.participants as GroupMetaEntry["participants"],
    expireAt: Date.now() + GROUP_META_TTL,
  };
  groupMetaCache.set(jid, entry);
  return entry;
}

export function invalidateGroupMetaCache(jid: string) {
  groupMetaCache.delete(jid);
}

export function populateGroupMetaCache(
  groups: Record<string, { subject: string; participants: Array<{ id: string; admin?: "admin" | "superadmin" | null }> }>
) {
  const expireAt = Date.now() + GROUP_META_TTL;
  for (const [jid, meta] of Object.entries(groups)) {
    groupMetaCache.set(jid, { subject: meta.subject, participants: meta.participants, expireAt });
  }
  return Object.keys(groups).length;
}

export function upsertGroupMetaCache(
  jid: string,
  meta: { subject?: string; participants?: Array<{ id: string; admin?: "admin" | "superadmin" | null }> }
) {
  const existing = groupMetaCache.get(jid);
  const updated: GroupMetaEntry = {
    subject: meta.subject ?? existing?.subject ?? "",
    participants: meta.participants ?? existing?.participants ?? [],
    expireAt: Date.now() + GROUP_META_TTL,
  };
  groupMetaCache.set(jid, updated);
}

// ── Activity logging ────────────────────────────────────────────────────────
// Maps raw Baileys message-type keys to a friendly, bracketed label used when
// there's no readable text body (media, stickers, replies, etc).
function printMessageActivity(opts: {
  msgType: string; pushName: string; senderNumber: string;
  isGroup: boolean; groupName?: string; groupNumber?: string;
}) {
  logger.debug({
    msgType: opts.msgType,
    isGroup: opts.isGroup,
    groupNumber: opts.groupNumber,
  }, "Incoming message without command text");
}

export interface CommandContext {
  jid: string;
  isGroup: boolean;
  isOwner: boolean;
  isSenderGroupAdmin: boolean;
  isBotGroupAdmin: boolean;
  groupSettings: GroupSettings | null;
  prefix: string;
}

function resolveMessageJid(sock: WASocket, rawJid: string, alternateJid?: string | null): string {
  if (!rawJid.endsWith("@lid")) return rawJid;

  if (alternateJid?.endsWith("@s.whatsapp.net")) {
    registerLidMapping(rawJid, alternateJid);
    return alternateJid;
  }

  const cached = resolveLid(rawJid);
  if (cached !== rawJid) return cached;
  return tryLiveResolveLid(sock, rawJid) ?? rawJid;
}

// ── Status broadcast handler ───────────────────────────────────────────────────
// Only processes statuses posted AFTER the bot connected (connectedAt guard is
// applied in connection.ts via the stale-message filter). This function only
// handles statuses that arrive as live notify events, never replayed history.
export async function handleStatusMessage(sock: WASocket, msg: WAMessage) {
  const settings   = getBotSettings();
  const senderJid  = msg.key.participant || msg.key.participantAlt || "";

  // Skip if no sender, or if sender IS status@broadcast (reaction notifications,
  // senderKeyDistribution etc — not actual status posts we should react to)
  if (!senderJid || senderJid === "status@broadcast") {
    logger.debug({ messageId: msg.key.id }, "Status event has no resolvable poster JID");
    return;
  }

  // WhatsApp may reject a status reaction until it has been marked viewed.
  // Read once for either feature so auto-like-only mode also works.
  if (settings.autoViewStatus || settings.autoLikeStatus) {
    try {
      await sock.readMessages([msg.key]);
      if (settings.autoViewStatus) logger.debug({ sender: senderJid }, "Status viewed");
    } catch (err) {
      logger.debug({ err, sender: senderJid }, "Status read receipt failed");
    }
  }

  if (settings.autoLikeStatus) {
    try {
      const emojiList = (settings.statusLikeEmoji || "❤️")
        .split(",").map((e) => e.trim()).filter(Boolean);
      const emoji = emojiList[Math.floor(Math.random() * emojiList.length)] || "❤️";

      await sock.sendMessage(
        "status@broadcast",
        { react: { text: emoji, key: { ...msg.key, remoteJid: "status@broadcast" } } },
        { statusJidList: [senderJid] }
      );
      logger.debug({ sender: senderJid, emoji }, "Status reaction sent");
    } catch (err) {
      logger.warn({ err, sender: senderJid }, "Status reaction failed");
    }
  }
}

// ── Version marker — visible in logs on every message, confirms deployment ────
// Change this string any time you deploy so you can verify the new build is live.
const HANDLER_VERSION = "v2.5-LID-LIVE-RESOLVE";

// ── Main message handler ───────────────────────────────────────────────────────
export async function handleMessage(sock: WASocket, msg: WAMessage) {
  if (!msg.key) {
    logger.warn("handleMessage called with no msg.key — dropped");
    return;
  }

  const ownerNumber   = (process.env["OWNER_NUMBER"] || "").replace(/[^0-9]/g, "");
  const defaultPrefix = process.env["PREFIX"] || ".";

  const jid = msg.key.remoteJid;
  if (!jid) {
    logger.warn("handleMessage: no remoteJid — dropped");
    return;
  }

  // Log version on first call so you can confirm the right build is deployed
  logger.debug({ v: HANDLER_VERSION }, "Handler version");

  // Drop protocol/Signal housekeeping messages
  const msgContent = msg.message;
  if (
    msgContent?.protocolMessage ||
    msgContent?.reactionMessage ||
    msgContent?.pollUpdateMessage ||
    msgContent?.keepInChatMessage ||
    msgContent?.senderKeyDistributionMessage
  ) {
    logger.info({ jid, type: msgContent ? Object.keys(msgContent)[0] : "unknown" }, "↩ Protocol message dropped in handler");
    return;
  }

  logger.debug({ jid, fromMe: msg.key.fromMe, msgKeys: Object.keys(msg.message || {}) }, "Message handler reached");

  const isGroup    = jid.endsWith("@g.us");
  const botJidFull = sock.user?.id || "";

  // ── isOwner detection ─────────────────────────────────────────────────────
  //
  // Messages sent from the linked WhatsApp account are owner commands in DMs
  // and groups, even where the owner's participant JID is represented by a LID.
  //
  // Case 2: incoming DM with @lid JID that still can't be resolved →
  //   The LID→JID mapping arrives via contacts.upsert shortly after connect.
  //   If it hasn't arrived yet, any unresolved @lid DM must be the owner
  //   since only the owner's number is paired to this bot session.
  //
  // Case 3: resolved phone number matches OWNER_NUMBER (groups + resolved DMs)
  let isOwner = false;
  let senderJidRaw: string;
  let realSenderJid: string;
  let senderNumber: string;

  if (msg.key.fromMe) {
    const linkedNumber = ownerNumber || botJidFull.split(":")[0].split("@")[0];
    isOwner       = true;
    senderJidRaw  = `${linkedNumber}@s.whatsapp.net`;
    realSenderJid = senderJidRaw;
    senderNumber  = linkedNumber;
    logger.debug({ jid }, "Owner identified via fromMe=true");
  } else {
    senderJidRaw  = isGroup ? (msg.key.participant || botJidFull) : jid;
    const alternateSenderJid = isGroup ? msg.key.participantAlt : msg.key.remoteJidAlt;
    realSenderJid = resolveMessageJid(sock, senderJidRaw, alternateSenderJid);
    senderNumber  = realSenderJid.split(":")[0].split("@")[0];

    const numberMatch = ownerNumber !== "" && senderNumber === ownerNumber;
    // An unresolved incoming @lid cannot be assumed to be the owner.
    isOwner = numberMatch;
    logger.debug(
      { ownerNumber, senderNumber, senderJidRaw, realSenderJid, numberMatch, isOwner },
      "🔑 Owner resolution"
    );
  }

  const msgType = Object.keys(msg.message || {})[0] || "unknown";
  const botMode = (process.env["BOT_MODE"] || "public").trim().toLowerCase();
  const body =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    msg.message?.documentMessage?.caption ||
    msg.message?.buttonsResponseMessage?.selectedButtonId ||
    msg.message?.listResponseMessage?.singleSelectReply?.selectedRowId ||
    msg.message?.templateButtonReplyMessage?.selectedId ||
    "";

  logger.info(
    {
      fromMe: !!msg.key.fromMe,
      isGroup,
      msgType,
      hasText: Boolean(body),
      botMode,
    },
    "Incoming message reached command handler"
  );

  if (botMode === "private" && !isOwner) {
    logger.info({ msgType, botMode }, "Message ignored by private mode");
    return;
  }

  if (!body) {
    printMessageActivity({ msgType, pushName: msg.pushName || "", senderNumber, isGroup });
    logger.info({ msgType }, "Message ignored because it has no text body");
    return;
  }

  let groupSettings: GroupSettings | null = null;
  let isSenderGroupAdmin = false;
  let isBotGroupAdmin    = false;
  let prefix   = defaultPrefix;
  let groupName: string | undefined;
  let groupNumber: string | undefined;

  if (isGroup) {
    groupSettings = getGroupSettings(jid);
    if (groupSettings?.customPrefix) prefix = groupSettings.customPrefix;

    const hasGroupProtection = !!groupSettings && (
      groupSettings.antilink ||
      groupSettings.antibadword !== "off" ||
      groupSettings.antimention
    );
    // Ordinary group chat and auto-replies do not need a network metadata
    // lookup. Fetch it only for commands or enabled moderation checks.
    const commandName = body.startsWith(prefix)
      ? body.slice(prefix.length).trim().split(/\s+/, 1)[0]?.toLowerCase() ?? ""
      : "";
    const needsGroupAdminContext = GROUP_ADMIN_CONTEXT_COMMANDS.has(commandName);
    // Don't let a cold group-metadata request delay ordinary commands such as
    // .ping. Moderation still checks metadata on non-command group messages.
    if (needsGroupAdminContext || (hasGroupProtection && !commandName)) {
      try {
        const groupMeta = await getCachedGroupMeta(sock, jid);
        groupName   = groupMeta.subject;
        groupNumber = jid.split("@")[0];
        const botNumber = botJidFull.split(":")[0].split("@")[0];

        for (const participant of groupMeta.participants) {
          const pNum    = participant.id.split(":")[0].split("@")[0];
          const isAdmin = participant.admin === "admin" || participant.admin === "superadmin";
          if (pNum === senderNumber) isSenderGroupAdmin = isAdmin;
          if (pNum === botNumber)    isBotGroupAdmin    = isAdmin;
        }

        const msgKey = msg.key as WAMessageKey;
        if (groupSettings) {
          if (groupSettings.antilink && !isOwner && !isSenderGroupAdmin && URL_REGEX.test(body)) {
            const violationKey = `${jid}:${realSenderJid}`;
            const now = Date.now();
            const previous = linkViolations.get(violationKey);
            const entry = !previous || now - previous.firstAt > 24 * 60 * 60 * 1000
              ? { count: 1, firstAt: now }
              : { count: previous.count + 1, firstAt: previous.firstAt };
            const count = entry.count;
            linkViolations.set(violationKey, entry);
            while (linkViolations.size > 3000) {
              const oldest = linkViolations.keys().next().value;
              if (!oldest) break;
              linkViolations.delete(oldest);
            }
            if (isBotGroupAdmin) {
              await safeSend(sock, jid, { delete: msgKey });
            }
            if (count > 1 && isBotGroupAdmin) {
              await sock.groupParticipantsUpdate(jid, [realSenderJid], "remove");
              linkViolations.delete(violationKey);
              await safeSend(sock, jid, {
                text: `🚫 @${realSenderJid.split("@")[0].split(":")[0]} was removed for posting another link after a warning.`,
                mentions: [realSenderJid],
              });
            } else {
              await safeSend(sock, jid, {
                text: isBotGroupAdmin
                  ? `⚠️ @${realSenderJid.split("@")[0].split(":")[0]}, links are not allowed. This is your first warning. Another link may result in removal.`
                  : "⚠️ Links are not allowed. Promote the bot to admin so it can delete links or remove repeat offenders.",
                mentions: [realSenderJid],
              });
            }
            return;
          }
          const badWordList = groupSettings.customBadWords
            ? groupSettings.customBadWords.split(",").map((w) => w.trim().toLowerCase()).filter(Boolean)
            : DEFAULT_BAD_WORDS;
          const matchedBadWord = findBadWord(body, badWordList);
          if (groupSettings.antibadword !== "off" && !isOwner && !isSenderGroupAdmin && matchedBadWord) {
            const violationKey = `${jid}:${realSenderJid}`;
            const now = Date.now();
            const previous = badWordViolations.get(violationKey);
            const entry = !previous || now - previous.firstAt > 24 * 60 * 60 * 1000
              ? { count: 1, firstAt: now }
              : { count: previous.count + 1, firstAt: previous.firstAt };
            badWordViolations.set(violationKey, entry);
            while (badWordViolations.size > 3000) {
              const oldest = badWordViolations.keys().next().value;
              if (!oldest) break;
              badWordViolations.delete(oldest);
            }
            if (isBotGroupAdmin) await safeSend(sock, jid, { delete: msgKey });
            if (groupSettings.antibadword === "kick" && entry.count >= 3 && isBotGroupAdmin) {
              await sock.groupParticipantsUpdate(jid, [realSenderJid], "remove");
              badWordViolations.delete(violationKey);
              await safeSend(sock, jid, {
                text: `🚫 @${realSenderJid.split("@")[0]} was removed after three bad-language violations in 24 hours.`,
                mentions: [realSenderJid],
              });
            } else {
              await safeSend(sock, jid, {
                text: groupSettings.antibadword === "kick"
                  ? `⚠️ @${realSenderJid.split("@")[0]}, please avoid bad language. Warning ${entry.count}/3 in 24 hours.`
                  : "Bad language is not allowed.",
                mentions: [realSenderJid],
              });
            }
            return;
          }
          if (groupSettings.antimention && !isOwner && !isSenderGroupAdmin) {
            const mentions = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
            if (mentions.length >= 5) {
              await safeSend(sock, jid, { delete: msgKey });
              await safeSend(sock, jid, { text: "Mass mentions are not allowed." });
              return;
            }
          }
        }
      } catch (err) {
        logger.debug({ err, jid }, "Group metadata lookup failed; continuing");
      }
    }
  }

  printMessageActivity({ msgType, pushName: msg.pushName || "", senderNumber, isGroup, groupName, groupNumber });

  if (!body.startsWith(prefix)) {
    logger.info({ prefix, msgType }, "Message ignored because it does not start with the configured prefix");
    if (isGroup && groupSettings?.autoReply) {
      try {
        const autoReplyMap: Record<string, string> = JSON.parse(groupSettings.autoReply);
        const bodyLower = body.toLowerCase().trim();
        const matched = Object.entries(autoReplyMap).find(([trigger]) => bodyLower.includes(trigger.toLowerCase()));
        if (matched) await safeSend(sock, jid, { text: matched[1] });
      } catch { /* skip */ }
    }
    return;
  }

  // ── Resolve reply JID ─────────────────────────────────────────────────────
  // For DMs: never send to a @lid JID — it silently fails after the first delivery.
  // Priority: fromMe → owner's real JID | resolved → real JID | live-resolved →
  // real JID | still @lid → raw @lid as last-resort fallback (logged as a warning
  // since delivery to a bare, unresolved @lid is not guaranteed).
  let replyJid: string;
  if (isGroup) {
    replyJid = jid;
  } else if (msg.key.fromMe) {
    const linkedNumber = ownerNumber || botJidFull.split(":")[0].split("@")[0];
    replyJid = `${linkedNumber}@s.whatsapp.net`;
  } else {
    const resolved = resolveMessageJid(sock, jid, msg.key.remoteJidAlt);
    if (resolved.endsWith("@lid")) {
      if (isOwner) {
        // Owner's LID not yet mapped — fall back to their real phone JID
        replyJid = `${ownerNumber}@s.whatsapp.net`;
        logger.info({ lid: jid, fallback: replyJid }, "🔀 Owner @lid unresolved — using owner JID as reply fallback");
      } else {
        // Last resort: reply directly to the raw @lid JID. This is not
        // guaranteed to deliver; Baileys' alternate JID and live mapping
        // lookup have already been tried.
        replyJid = jid;
        logger.warn({ lid: jid }, "⚠️ Unknown @lid — no mapping available, reply may not deliver");
      }
    } else {
      replyJid = resolved;
      if (replyJid !== jid) logger.info({ lid: jid, resolved: replyJid }, "🔀 @lid resolved for reply");
    }
  }

  const userSettings = getUserSettings(realSenderJid);
  if (userSettings?.isBanned && !isOwner) {
    await safeSend(sock, replyJid, { text: "You are banned from using this bot." });
    return;
  }

  const ctx: CommandContext = { jid: replyJid, isGroup, isOwner, isSenderGroupAdmin, isBotGroupAdmin, groupSettings, prefix };
  const commandText = body.slice(prefix.length).trim();
  const parts = commandText.split(/\s+/).filter(Boolean);
  const [command = "", ...args] = parts;
  const cmd = command.toLowerCase();

  // Patch msg key so quoted replies go to the correct chat, not @lid
  let patchedMsg = msg.key.remoteJid !== replyJid
    ? { ...msg, key: { ...msg.key, remoteJid: replyJid } }
    : msg;

  logger.info({ cmd, jid, replyJid, isOwner }, "Command received");

  switch (cmd) {
    case "ping":           return handlePing(sock, patchedMsg, ctx);
    case "alive":          return handleAlive(sock, patchedMsg, ctx);
    case "menu":           return handleMenu(sock, patchedMsg, ctx, prefix);
    case "owner":          return handleOwner(sock, patchedMsg, ctx);
    case "settings":       return handleSettings(sock, patchedMsg, ctx, prefix);
    case "sticker":        return handleSticker(sock, patchedMsg, ctx);
    case "restart":        return handleRestart(sock, patchedMsg, ctx);
    case "refreshsession":
    case "getsession":     return handleRefreshSession(sock, patchedMsg, ctx);
    case "meme":
    case "joke":
    case "quote":
    case "trivia":
    case "8ball":
    case "ship":
    case "love":
    case "hug":
      return handleFunCommand(sock, patchedMsg, ctx, cmd, args);

    case "autoviewstatus":
    case "autoview": {
      if (!isOwner) { await safeSend(sock, replyJid, { text: "🚫 Only owner command" }); return; }
      const val = args[0]?.toLowerCase();
      if (val !== "true" && val !== "false" && val !== "on" && val !== "off") {
        await safeSend(sock, replyJid, { text: `Current: ${getBotSettings().autoViewStatus ? "ON" : "OFF"}\nUsage: ${prefix}autoviewstatus on/off` });
        return;
      }
      const enabled = val === "true" || val === "on";
      updateBotSettings({ autoViewStatus: enabled });
      await safeSend(sock, replyJid, { text: `Auto-view status: *${enabled ? "ON" : "OFF"}*` });
      return;
    }

    case "autolikestatus":
    case "autolike": {
      if (!isOwner) { await safeSend(sock, replyJid, { text: "🚫 Only owner command" }); return; }
      const val = args[0]?.toLowerCase();
      if (val !== "true" && val !== "false" && val !== "on" && val !== "off") {
        await safeSend(sock, replyJid, { text: `Current: ${getBotSettings().autoLikeStatus ? "ON" : "OFF"}\nUsage: ${prefix}autolikestatus on/off` });
        return;
      }
      const enabled = val === "true" || val === "on";
      updateBotSettings({ autoLikeStatus: enabled });
      await safeSend(sock, replyJid, { text: `Auto-like status: *${enabled ? "ON" : "OFF"}*` });
      return;
    }

    case "statusemoji": {
      if (!isOwner) { await safeSend(sock, replyJid, { text: "🚫 Only owner command" }); return; }
      const emoji = args.join(" ").trim();
      if (!emoji) {
        await safeSend(sock, replyJid, { text: `Current emoji: ${getBotSettings().statusLikeEmoji}\nUsage: ${prefix}statusemoji ❤️,🔥,😍` });
        return;
      }
      updateBotSettings({ statusLikeEmoji: emoji });
      await safeSend(sock, replyJid, { text: `Status like emoji set to: *${emoji}*` });
      return;
    }

    case "autoread":
    case "smartreply": {
      if (!isOwner) {
        await safeSend(sock, replyJid, { text: "🚫 Only the owner can change bot-wide features." });
        return;
      }
      const raw = args[0]?.toLowerCase();
      if (raw !== "on" && raw !== "off") {
        const settings = getBotSettings();
        const enabled = command === "autoread" ? settings.autoRead : settings.smartReply;
        await safeSend(sock, replyJid, {
          text: `Usage: ${prefix}${command} on | ${prefix}${command} off\nCurrent: ${enabled ? "ON" : "OFF"}`,
        });
        return;
      }
      const enabled = raw === "on";
      if (command === "autoread") updateBotSettings({ autoRead: enabled });
      else updateBotSettings({ smartReply: enabled });
      await safeSend(sock, replyJid, { text: `${command} is now ${enabled ? "ON" : "OFF"}.` });
      return;
    }

    case "kick":          return handleKick(sock, patchedMsg, ctx);
    case "add":           return handleAdd(sock, patchedMsg, ctx, args);
    case "promote":       return handlePromote(sock, patchedMsg, ctx);
    case "demote":        return handleDemote(sock, patchedMsg, ctx);
    case "antilink":      return handleAntilink(sock, patchedMsg, ctx, args);
    case "antibadword":   return handleAntibadword(sock, patchedMsg, ctx, args);
    case "setbadwords":   return handleSetBadWords(sock, patchedMsg, ctx, args);
    case "antimention":   return handleAntimention(sock, patchedMsg, ctx, args);
    case "antidelete":    return handleAntiDelete(sock, patchedMsg, ctx, args);
    case "antiedit":      return handleAntiEdit(sock, patchedMsg, ctx, args);
    case "antinudes":     return handleAntiNudes(sock, patchedMsg, ctx, args);
    case "ban":           return handleBan(sock, patchedMsg, ctx);
    case "unban":         return handleUnban(sock, patchedMsg, ctx);
    case "setprefix":     return handleSetPrefix(sock, patchedMsg, ctx, args);
    case "tagall":        return handleTagAll(sock, patchedMsg, ctx, args);
    case "groupinfo":     return handleGroupInfo(sock, patchedMsg, ctx);
    case "mute":          return handleMute(sock, patchedMsg, ctx);
    case "unmute":        return handleUnmute(sock, patchedMsg, ctx);
    case "welcome":       return handleWelcome(sock, patchedMsg, ctx, args);
    case "setwelcome":    return handleSetWelcome(sock, patchedMsg, ctx, args);
    case "autoreply":     return handleAutoReply(sock, patchedMsg, ctx, args);

    default:
      await safeSend(sock, replyJid, { text: `Unknown command. Send ${prefix}menu to see the working commands.` });
      return;
  }
}

export async function handleGroupParticipantsUpdate(
  sock: WASocket,
  update: { id: string; participants: Array<{ id: string } | string>; action: string }
) {
  if (update.action !== "add") return;
  const groupId = update.id;
  try {
    const settings = getGroupSettings(groupId);
    if (!settings?.welcomeEnabled) return;
    const groupMeta = await sock.groupMetadata(groupId);
    const welcomeTemplate = settings.welcomeMessage || "Welcome to *{group}*, {name}! 🎉";
    for (const participant of update.participants) {
      const participantJid = typeof participant === "string" ? participant : participant.id;
      const name = `@${participantJid.split("@")[0]}`;
      const welcomeText = welcomeTemplate
        .replace(/\{name\}/gi, name)
        .replace(/\{group\}/gi, groupMeta.subject);
      await safeSend(sock, groupId, { text: welcomeText, mentions: [participantJid] });
    }
  } catch (err) {
    logger.warn({ err, groupId }, "Failed to send welcome message");
  }
}
