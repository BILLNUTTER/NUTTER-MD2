import type { WASocket, WAMessage } from "@whiskeysockets/baileys";
import type { CommandContext } from "../handler";
import { safeSend } from "../utils";

const JOKES = [
  "Why did the computer get cold? It left its Windows open.",
  "I told my phone I needed a break. It put me on airplane mode.",
  "Why do developers like dark mode? Because light attracts bugs.",
  "A bot walks into a group chat. The admins ask, “Are you here to help?” It replies, “That depends on your permissions.”",
];

const QUOTES = [
  "“It always seems impossible until it’s done.” — Nelson Mandela",
  "“The secret of getting ahead is getting started.” — Mark Twain",
  "“Great things are done by a series of small things brought together.” — Vincent van Gogh",
  "“Simplicity is the ultimate sophistication.” — Leonardo da Vinci",
];

const TRIVIA = [
  { question: "Which planet has the most moons confirmed so far?", options: "A) Earth  B) Jupiter  C) Saturn", answer: "C) Saturn" },
  { question: "What is the largest ocean on Earth?", options: "A) Atlantic  B) Pacific  C) Indian", answer: "B) Pacific" },
  { question: "Which element has the chemical symbol O?", options: "A) Gold  B) Oxygen  C) Osmium", answer: "B) Oxygen" },
];

const EIGHT_BALL_ANSWERS = [
  "Yes — definitely.",
  "The signs point to yes.",
  "Ask again in a little while.",
  "Not likely.",
  "I can’t predict that right now.",
];

const TEXT_MEMES = [
  "Me: I’ll fix one small bug.\nThe bot: *reveals 36 commands with no handlers*",
  "When the command works on the first try:\n*checks the logs anyway*",
  "Bot: I’m online.\nAlso bot: waiting for the WhatsApp connection…",
];

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)]!;
}

function stableScore(input: string): number {
  let hash = 2166136261;
  for (const char of input.toLowerCase()) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0) % 101;
}

export async function handleFunCommand(
  sock: WASocket,
  msg: WAMessage,
  ctx: CommandContext,
  command: string,
  args: string[]
) {
  switch (command) {
    case "meme":
      await safeSend(sock, ctx.jid, { text: `😂 ${pick(TEXT_MEMES)}` }, { quoted: msg });
      return;
    case "joke":
      await safeSend(sock, ctx.jid, { text: `😄 ${pick(JOKES)}` }, { quoted: msg });
      return;
    case "quote":
      await safeSend(sock, ctx.jid, { text: `💬 ${pick(QUOTES)}` }, { quoted: msg });
      return;
    case "trivia": {
      const item = pick(TRIVIA);
      await safeSend(
        sock,
        ctx.jid,
        { text: `🧠 ${item.question}\n${item.options}\n\nAnswer: ${item.answer}` },
        { quoted: msg }
      );
      return;
    }
    case "8ball": {
      if (!args.length) {
        await safeSend(sock, ctx.jid, { text: `Ask a yes-or-no question.\nUsage: ${ctx.prefix}8ball Will I have a good day?` });
        return;
      }
      await safeSend(sock, ctx.jid, { text: `🎱 ${pick(EIGHT_BALL_ANSWERS)}` }, { quoted: msg });
      return;
    }
    case "ship":
    case "love": {
      const names = args.join(" ").split(/\s+(?:x|&|and)\s+/i).map((name) => name.trim()).filter(Boolean);
      if (names.length < 2) {
        await safeSend(sock, ctx.jid, { text: `Provide two names.\nUsage: ${ctx.prefix}${command} Alex and Sam` });
        return;
      }
      const pair = [names[0]!, names[1]!].sort((a, b) => a.localeCompare(b));
      const score = stableScore(`${pair[0]}|${pair[1]}`);
      const emoji = score > 79 ? "💞" : score > 49 ? "❤️" : "🫶";
      await safeSend(sock, ctx.jid, { text: `${emoji} *${names[0]} + ${names[1]}*: ${score}%` }, { quoted: msg });
      return;
    }
    case "hug": {
      const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
      const target = mentioned || args.join(" ").trim();
      const display = mentioned ? `@${mentioned.split("@")[0]}` : target || "you";
      await safeSend(
        sock,
        ctx.jid,
        { text: `🤗 Sending a warm hug to ${display}!`, ...(mentioned ? { mentions: [mentioned] } : {}) },
        { quoted: msg }
      );
      return;
    }
  }
}
