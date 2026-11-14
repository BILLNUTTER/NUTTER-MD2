import { downloadMediaMessage, type WASocket, type WAMessage } from "@whiskeysockets/baileys";
import pino from "pino";
import sharp from "sharp";
import { logger } from "../lib/logger";
import { getBotSettings, getGroupSettings } from "./store";

const processedStickerIds = new Set<string>();
const stickerWarnings = new Map<string, number>();
const smartReplyCooldowns = new Map<string, number>();
const silentLogger = pino({ level: "silent" });

function rememberBounded(set: Set<string>, key: string, limit: number) {
  set.add(key);
  while (set.size > limit) {
    const oldest = set.values().next().value;
    if (oldest === undefined) break;
    set.delete(oldest);
  }
}

export function markIncomingMessagesRead(sock: WASocket, messages: WAMessage[]) {
  const eligible = messages
    .filter((message) => {
      const jid = message.key.remoteJid ?? "";
      return Boolean(
        message.key.id &&
        !message.key.fromMe &&
        jid &&
        jid !== "status@broadcast" &&
        !jid.endsWith("@broadcast") &&
        !jid.endsWith("@newsletter")
      );
    })
    .map((message) => ({
      remoteJid: message.key.remoteJid!,
      id: message.key.id!,
      participant: message.key.participant,
      fromMe: false,
    }));

  if (!eligible.length) return;
  void sock.readMessages(eligible).catch((err: unknown) => {
    logger.debug({ error: err instanceof Error ? err.message : "unknown" }, "Auto-read receipt failed");
  });
}

function smartReplyFor(text: string): string | null {
  const normalized = text.toLowerCase().trim().replace(/[.!?,\s]+$/g, "");
  if (/^(hi|hie|hey|hello|yo|sasa|niaje|mambo|vipi|habari)(\s+(bro|buda|msee|maze|boss))*$/.test(normalized)) {
    return "Niaje 😎 uko aje?";
  }
  if (/^(how are you|how are u|how r u|uko aje|uko poa|you good)$/.test(normalized)) {
    return "Niko poa sana 😎 wewe je?";
  }
  if (/^(thank you|thanks|asante|shukran)$/.test(normalized)) {
    return "Karibu 😊";
  }
  if (/^(bye|goodbye|later|gn|goodnight|lala salama)$/.test(normalized)) {
    return "Sawa, take care 😊";
  }
  if (/^(😂+|😭+|💀+|👀+|hmm+|wueh+|bruh+)$/.test(normalized)) {
    return "😂😂 sema basi";
  }
  if (normalized.length <= 12) return "Nimekupata 😂 sema zaidi.";
  if (/\b(sad|stressed|heartbroken|nimechoka|niko down|pole)\b/.test(normalized)) {
    return "Pole sana 🫂 unataka kuongea kuhusu kilichotokea?";
  }
  return null;
}

function isBotCommand(text: string) {
  const prefix = process.env["PREFIX"] || ".";
  const trimmed = text.trim();
  return (
    (prefix && trimmed.startsWith(prefix) && trimmed.length > prefix.length) ||
    /^[.!/#$][a-z0-9_-]+(?:\s|$)/i.test(trimmed)
  );
}

export function installSmartReply(sock: WASocket) {
  sock.ev.on("messages.upsert", ({ messages, type }) => {
    if (type !== "notify") return;
    if ((process.env["BOT_MODE"] || "public").trim().toLowerCase() === "private") return;
    if (!getBotSettings().smartReply) return;

    for (const message of messages) {
      const jid = message.key.remoteJid ?? "";
      if (message.key.fromMe || !message.message || !jid || jid.endsWith("@g.us")) continue;
      if (jid === "status@broadcast" || jid.endsWith("@newsletter")) continue;
      if (isBotCommand(message.message.conversation ?? message.message.extendedTextMessage?.text ?? "")) continue;

      const text = message.message.conversation ?? message.message.extendedTextMessage?.text ?? "";
      if (!text.trim()) continue;

      const sentAt = Number(message.messageTimestamp) || 0;
      if (sentAt > 0 && Date.now() / 1000 - sentAt > 120) continue;

      const lastReplyAt = smartReplyCooldowns.get(jid) ?? 0;
      if (Date.now() - lastReplyAt < 10_000) continue;

      const reply = smartReplyFor(text);
      if (!reply) continue;

      smartReplyCooldowns.set(jid, Date.now());
      while (smartReplyCooldowns.size > 1000) {
        const oldest = smartReplyCooldowns.keys().next().value;
        if (!oldest) break;
        smartReplyCooldowns.delete(oldest);
      }

      void sock.sendMessage(jid, { text: reply }, { quoted: message })
        .then(() => logger.info({ messageType: "text" }, "Smart reply sent"))
        .catch((err: unknown) => logger.warn(
          { error: err instanceof Error ? err.message : "unknown" },
          "Smart reply could not be sent"
        ));
    }
  });
}

let nsfwModelPromise: Promise<{ model: { classify: (image: unknown) => Promise<Array<{ className: string; probability: number }>> }; tf: any }> | null = null;

async function loadNsfwModel() {
  if (!nsfwModelPromise) {
    nsfwModelPromise = (async () => {
      // Keep TensorFlow/model loading off the bot startup path. It starts only
      // after an admin enables sticker moderation and a sticker is received.
      const tfPackage = "@tensorflow/tfjs";
      const nsfwPackage = "nsfwjs";
      const tf = await import(tfPackage);
      const nsfwjs = await import(nsfwPackage);
      await tf.setBackend("cpu");
      await tf.ready();
      const model = await nsfwjs.load("MobileNetV2");
      return { model, tf };
    })().catch((err) => {
      nsfwModelPromise = null;
      throw err;
    });
  }
  return nsfwModelPromise;
}

function normalizeJid(jid: string) {
  return jid.toLowerCase().replace(/:\d+@/, "@");
}

function isAdmin(participants: Array<{ id?: string; jid?: string; lid?: string; phoneNumber?: string; admin?: "admin" | "superadmin" | null }>, jid: string) {
  const target = normalizeJid(jid);
  return participants.some((participant) => {
    const matches = [participant.id, participant.jid, participant.lid, participant.phoneNumber]
      .filter((value): value is string => Boolean(value))
      .some((value) => normalizeJid(value) === target);
    return matches && (participant.admin === "admin" || participant.admin === "superadmin");
  });
}

async function moderateSticker(sock: WASocket, message: WAMessage, groupJid: string, senderJid: string) {
  const key = message.key;
  const messageId = key.id;
  if (!messageId || !message.message?.stickerMessage) return;

  const processedKey = `${groupJid}:${messageId}`;
  if (processedStickerIds.has(processedKey)) return;
  rememberBounded(processedStickerIds, processedKey, 3000);

  const settings = getGroupSettings(groupJid);
  if (!settings?.antiNudes || key.fromMe) return;

  const metadata = await sock.groupMetadata(groupJid);
  if (isAdmin(metadata.participants, senderJid)) return;
  const botJid = sock.user?.id ?? "";
  if (!isAdmin(metadata.participants, botJid)) {
    logger.warn("Sticker moderation is enabled, but the bot is not a group admin");
    return;
  }

  const modelState = await loadNsfwModel();
  const media = await downloadMediaMessage(
    message,
    "buffer",
    {},
    { logger: silentLogger, reuploadRequest: sock.updateMediaMessage }
  );
  if (!Buffer.isBuffer(media) || media.length === 0 || media.length > 10 * 1024 * 1024) return;

  const image = await sharp(media, { limitInputPixels: 40_000_000 })
    .rotate()
    .resize(224, 224, { fit: "cover" })
    .flatten({ background: "#ffffff" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (image.info.channels !== 3) return;

  const tensor = modelState.tf.tensor3d(
    new Int32Array(image.data),
    [image.info.height, image.info.width, 3],
    "int32"
  );
  let predictions: Array<{ className: string; probability: number }>;
  try {
    predictions = await modelState.model.classify(tensor);
  } finally {
    tensor.dispose();
  }

  const scores = Object.fromEntries(predictions.map((item) => [item.className, item.probability]));
  if ((Number(scores["Porn"]) || 0) < 0.35 && (Number(scores["Hentai"]) || 0) < 0.4) return;

  await sock.sendMessage(groupJid, { delete: key });
  const warningKey = `${groupJid}:${normalizeJid(senderJid)}`;
  const count = (stickerWarnings.get(warningKey) ?? 0) + 1;
  stickerWarnings.set(warningKey, count);
  if (count === 1) {
    await sock.sendMessage(groupJid, {
      text: `⚠️ @${senderJid.split("@")[0].split(":")[0]}, explicit stickers are not allowed. A repeat may result in removal.`,
      mentions: [senderJid],
    });
    return;
  }
  await sock.groupParticipantsUpdate(groupJid, [senderJid], "remove");
  stickerWarnings.delete(warningKey);
  await sock.sendMessage(groupJid, {
    text: `🚫 @${senderJid.split("@")[0].split(":")[0]} was removed for repeatedly posting explicit stickers.`,
    mentions: [senderJid],
  });
}

export function installNudesModeration(sock: WASocket) {
  sock.ev.on("messages.upsert", ({ messages, type }) => {
    if (type !== "notify") return;
    for (const message of messages) {
      const groupJid = message.key.remoteJid ?? "";
      const senderJid = message.key.participant ?? message.key.participantAlt ?? "";
      if (!groupJid.endsWith("@g.us") || !senderJid || !message.message?.stickerMessage) continue;
      void moderateSticker(sock, message, groupJid, senderJid).catch((err: unknown) => {
        logger.warn(
          { error: err instanceof Error ? err.message : "unknown" },
          "Explicit-sticker moderation failed"
        );
      });
    }
  });
}
