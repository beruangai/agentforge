# {consumer}/{project} — the agentic base image.
#
# The consumer's layer over AgentForge's: the skills, tools, MCP servers and
# prompt foundation a GROUP of agents share (ARCHITECTURE.md §6). A change here
# must move every agent above it, and nothing else.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}

COPY --chown=0:0 capabilities/ /opt/agentforge/capabilities/
ENV CLAUDE_CONFIG_DIR=/opt/agentforge/capabilities
