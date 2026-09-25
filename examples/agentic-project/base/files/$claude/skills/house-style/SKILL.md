---
name: house-style
description: The house style for TypeScript source, with rule ids R1–R3. Use it whenever reviewing or changing a source file.
---

# House style

Three rules, each with an id. Cite a rule by its id; its full text is served by the house MCP server's `lookup_rule` tool.

- **R1** — exported functions are documented
- **R2** — no `var`
- **R3** — no TODO comments

A violation is reported against the line it is on, counting from 1. When fixing, change only what a rule requires and keep everything else byte for byte.
