---
name: Baileys upsert event handling
description: Handling linked-account messages that may arrive as append events without replaying stale history.
---

Handle inbound messages delivered as `notify`; linked-account messages can also arrive as `append`. Only process `append` messages with `key.fromMe` set, and keep the stale-message cutoff so history replay does not execute old commands.

**Why:** Dropping every non-`notify` event can discard commands sent by the account linked to the bot.

**How to apply:** When changing `messages.upsert` handling, preserve the owner-only `append` path and do not process append history from other senders.
