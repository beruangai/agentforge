# Claude Agent SDK Development

When implementing SDK applications, skills, plugins, subagents, or MCP tools, fetch current documentation before proceeding:

**SDK documentation (WebFetch for the latest):**
- [Sessions](https://code.claude.com/docs/en/agent-sdk/sessions.md) and [session storage](https://code.claude.com/docs/en/agent-sdk/session-storage.md)
- [SubAgents](https://code.claude.com/docs/en/agent-sdk/subagents.md)
- [Skills](https://code.claude.com/docs/en/agent-sdk/skills.md)
- [Plugins](https://code.claude.com/docs/en/agent-sdk/plugins.md)
- [Custom Tools](https://code.claude.com/docs/en/agent-sdk/custom-tools.md)
- [Slash Commands](https://code.claude.com/docs/en/agent-sdk/slash-commands.md)
- [Permissions](https://code.claude.com/docs/en/agent-sdk/permissions.md)

The platform evolves rapidly. Always verify patterns against current docs, and record what you verified — with the date — in `docs/research/claude-agent-sdk.md`.

## Structured outputs

Do not rely on remembered rules for converting Zod schemas to the structured-output JSON Schema (draft target, `$defs`, `format`, `const`/`enum`, non-object roots). They changed across SDK versions and are re-established against the current SDK by the settlement spike in `docs/DESIGN_OPTIONS.md` §E. Verify before encoding any conversion.

## Settlement

the predecessor harness's rules for deciding when a run is final — foreground-only agent work, recovering a dropped submission, background-task tracking — are evidence, not fact. `docs/DESIGN_OPTIONS.md` §E establishes what holds on the current SDK.
