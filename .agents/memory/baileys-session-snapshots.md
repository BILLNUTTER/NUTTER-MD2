---
name: Baileys session snapshot restoration
description: Restore serialized Signal ratchets from SESSION_ID while preserving newer local auth state.
---

Restore all files in a valid SESSION_ID snapshot, including `session-*.json`. On a dyno with existing files, preserve current disk state instead of overwriting it with an older snapshot.

**Why:** A Heroku dyno with credentials and pre-keys but no saved Signal ratchets can connect yet fail to decrypt existing chats, producing Bad MAC and closed-session errors.

**How to apply:** Keep complete Baileys auth snapshots intact during import and avoid purging session ratchets on startup. If a deploy continues to show decryption failures, capture redacted runtime logs and pair a fresh device session.
