/**
 * patch-baileys.mjs
 *
 * Patches @whiskeysockets/baileys messages-recv.js so that a "Key used already
 * or never filled" (MISSING_KEYS_ERROR_TEXT) decryption failure sends a proper
 * retry receipt (with a pre-key upload) instead of silently ACKing.
 *
 * Without this patch:
 *   - Contact sends message encrypted with a pre-key the bot no longer has
 *   - Baileys detects MISSING_KEYS_ERROR_TEXT, emits ACK only, returns
 *   - No retry is sent; the contact's WA thinks delivery succeeded
 *   - msg.message is null forever; bot never responds
 *
 * With this patch:
 *   - MISSING_KEYS_ERROR_TEXT falls through to the isPreKeyError branch
 *   - Baileys uploads 5 fresh pre-keys, waits 1 s, sends retry receipt
 *   - Contact's WA fetches a newly uploaded pre-key, re-encrypts, resends
 *   - Bot decrypts with the fresh pre-key; message goes through
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function findPnpmFile(packagePrefix, packageName, relativeFile) {
  const candidates = [
    path.join(__dirname, 'node_modules', packageName, relativeFile),
    path.join(__dirname, 'artifacts/api-server/node_modules', packageName, relativeFile),
  ];
  const store = path.join(__dirname, 'node_modules/.pnpm');
  if (fs.existsSync(store)) {
    for (const entry of fs.readdirSync(store)) {
      if (entry.startsWith(packagePrefix)) {
        candidates.push(path.join(store, entry, 'node_modules', packageName, relativeFile));
      }
    }
  }
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function patchBaileysRetry() {
  const target = findPnpmFile(
    '@whiskeysockets+baileys@',
    '@whiskeysockets/baileys',
    'lib/Socket/messages-recv.js',
  );
  if (!target) {
    console.warn('[patch-baileys] messages-recv.js not found — skipping retry patch');
    return;
  }

  let src = fs.readFileSync(target, 'utf-8');
  if (src.includes('NUTTER_XMD_PATCHED')) {
    console.log('[patch-baileys] Retry patch already applied');
    return;
  }

  // In current Baileys, this early ACK prevents a missing-session/pre-key
  // ciphertext from reaching the normal retry-request path below.
  const currentGuard = /if\s*\(msg\?\.messageStubParameters\?\.\[0\]\s*===\s*MISSING_KEYS_ERROR_TEXT\)\s*\{\s*acked\s*=\s*true;\s*return\s+sendMessageAck\(node,\s*NACK_REASONS\.ParsingError\);\s*\}/;
  if (currentGuard.test(src)) {
    src = src.replace(
      currentGuard,
      '// NUTTER_XMD_PATCHED: let missing-key ciphertext reach the retry-request path',
    );
    fs.writeFileSync(target, src, 'utf-8');
    console.log('[patch-baileys] Missing-key retry patch applied');
    return;
  }

  console.warn('[patch-baileys] Missing-key retry pattern not found; inspect the installed Baileys version');
}

function patchLibsignalLogRedaction() {
  const target = findPnpmFile('libsignal@', 'libsignal', 'src/session_record.js');
  if (!target) {
    console.warn('[patch-baileys] libsignal session_record.js not found — skipping log redaction');
    return;
  }

  let src = fs.readFileSync(target, 'utf-8');
  if (src.includes('NUTTER_SIGNAL_LOGS_REDACTED')) {
    console.log('[patch-baileys] Signal session log redaction already applied');
    return;
  }

  const replacements = [
    [
      /console\.warn\(["']Session already closed["'],\s*session\);/,
      'console.warn("Session already closed (session details redacted)");',
    ],
    [
      /console\.info\(["']Closing session:["'],\s*session\);/,
      'console.info("Closing session (session details redacted)");',
    ],
    [
      /console\.info\(["']Opening session:["'],\s*session\);/,
      'console.info("Opening session (session details redacted)");',
    ],
  ];

  if (!replacements.every(([pattern]) => pattern.test(src))) {
    console.warn('[patch-baileys] Signal log patterns changed; session objects were not patched');
    return;
  }

  for (const [pattern, replacement] of replacements) {
    src = src.replace(pattern, replacement);
  }
  src = `// NUTTER_SIGNAL_LOGS_REDACTED\n${src}`;
  fs.writeFileSync(target, src, 'utf-8');
  console.log('[patch-baileys] Sensitive Signal session objects redacted from logs');
}

patchBaileysRetry();
patchLibsignalLogRedaction();
