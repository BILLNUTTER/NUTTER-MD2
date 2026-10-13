---
name: NUTTER-XMD dependency compatibility
description: Compatibility constraints encountered while importing and regenerating the NUTTER-XMD app.
---

The upstream Baileys 7.0.0-rc.9 tarball was blocked by Replit's package registry. The latest available release installed, but makes `proto.IWebMessageInfo.key` nullable/optional; use Baileys' `WAMessage` type for live incoming messages and the antidelete cache.

The current Orval release generates Zod 4 schemas and React Query 5 hooks. Keep the Zod and form resolver versions aligned with those outputs, include `DOM.Iterable` in the API client TypeScript libs, and configure Orval for React Query 5.

**Why:** The imported repository's dependencies and generated client were out of sync with the versions accepted by this workspace, preventing a clean install and typecheck.

**How to apply:** If refreshing the upstream lockfile or regenerating API types, validate package registry availability first, then run API codegen and the full workspace typecheck before restarting the app.
