# The AgentCore fixture container. ARM64 only — AgentCore Runtime takes nothing
# else. BUN_IMAGE has no default: the test passes the base image's own pinned
# Bun image, so a build outside the test fails rather than floating on a tag.
ARG BUN_IMAGE
FROM ${BUN_IMAGE}
WORKDIR /opt/agentforge
COPY server.js /opt/agentforge/server.js
ENV A2A_PORT=9000
EXPOSE 9000
CMD ["bun", "/opt/agentforge/server.js"]
