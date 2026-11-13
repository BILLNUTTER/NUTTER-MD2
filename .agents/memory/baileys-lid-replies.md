---
name: Baileys LID reply routing
description: Resolve message sender and reply addresses from Baileys alternate phone-number JIDs.
---

When an incoming DM or group participant uses an `@lid` JID, prefer `remoteJidAlt` or `participantAlt` when it is a phone-number JID, register the mapping, then use the mapped JID for owner checks and replies.

**Why:** A bot can process a command quickly but fail or delay delivery when it replies to an unresolved `@lid` address.

**How to apply:** Resolve alternate JIDs before both sender authorization and reply routing. Keep the live signal-repository lookup as a fallback; raw `@lid` is only a last resort.
