---
name: y-space-integrations
description: Use Y Space connections backed by Pipedream to work with connected services through Personal MCP or user-authorized BYO Connect accounts. Use when a task needs a third-party app, account, or integration that appears in Y Space Connections.
---

# Y Space Integrations

Y Space exposes two Pipedream-backed connection paths:

- **Personal MCP** for the user's own Pipedream MCP account and tools.
- **BYO Connect** for accounts the user explicitly connected inside Y Space.

## Choose a connection

1. Inspect the available MCP servers/tools and use an already connected service when it matches the request.
2. Prefer a purpose-built service tool for semantic operations. Use the embedded browser only when visual interaction, a rendered page, or local web testing is required.
3. If the required account is missing, identify the exact app and ask the user to connect it in **Settings → Connections**. Resume after Y Space reports that the account is connected.
4. Treat each connection as user-scoped. Do not reuse a connection that belongs to another task or identity when Y Space rejects the session binding.

## Credential boundary

Y Space brokers Pipedream credentials outside the agent process. Always use the provided MCP or app-control surface; never request, reveal, or persist credentials, API keys, OAuth tokens, cookie values, Connect tokens, or authorization headers. Do not search `.env` files for integration secrets and do not echo configuration values in logs or responses.

On an authorization failure, report that reconnection may be required. Do not replay a state-changing tool call unless the tool surface explicitly confirms that retry is safe.

## External effects

Reading connected data is normally safe. Pause before sending messages, changing records, publishing content, making purchases, deleting data, or triggering other irreversible actions unless the user explicitly authorized that exact effect.
