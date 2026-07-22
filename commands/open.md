---
description: Open the Attention Router dashboard, starting its local server if needed
allowed-tools: Bash(node *)
---

Run this exact command and report its output verbatim, without adding commentary:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/open.js"
```

This ensures the local dashboard daemon (`server/index.js`, default port 4123) is running, then opens `http://localhost:4123` with the platform's default opener. If no opener is available, it prints the URL instead — in that case just tell the user to open it manually.
