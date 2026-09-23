# RefDex

RefDex is a method-level code index for AI assistants. It parses C#, Java, Python and TypeScript into
a local SQLite index and serves it to Claude Code and GitHub Copilot through an MCP server, so the AI
can look up signatures and outlines instead of reading whole files.

This is an early development build: the extension does not index anything yet.
