# Claude Agent SDK Development

When implementing SDK applications, skills, plugins, subagents, or MCP tools, fetch current documentation before proceeding:

**SDK Documentation (WebFetch for latest):**
- [SubAgents](https://platform.claude.com/docs/en/agent-sdk/subagents.md)
- [Skills](https://platform.claude.com/docs/en/agent-sdk/skills.md)
- [Plugins](https://platform.claude.com/docs/en/agent-sdk/plugins.md)
- [Custom Tools](https://platform.claude.com/docs/en/agent-sdk/custom-tools.md)
- [Slash Commands](https://platform.claude.com/docs/en/agent-sdk/slash-commands.md)
- [Permissions](https://platform.claude.com/docs/en/agent-sdk/permissions.md)

The platform evolves rapidly. Always verify patterns against current docs.

## Structured Outputs

When using `outputFormat` with Zod schemas, always specify `target: "draft-07"`:

```typescript
// ✅ Correct - Claude requires JSON Schema draft-07
const schema = z.toJSONSchema(MySchema, { target: "draft-07" });

// ❌ Wrong - Zod defaults to draft-2020-12 which Claude doesn't support
const schema = z.toJSONSchema(MySchema);
```

Usage in query options:
```typescript
outputFormat: {
  type: "json_schema",
  schema: z.toJSONSchema(MySchema, { target: "draft-07" }),
}
```
