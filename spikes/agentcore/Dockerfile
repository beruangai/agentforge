# The AgentCore spike container. ARM64 only — AgentCore Runtime requires it.
ARG BUN_IMAGE=oven/bun:1.4.0-alpine
FROM ${BUN_IMAGE}
WORKDIR /opt/agentforge
COPY server.js /opt/agentforge/server.js
ENV A2A_PORT=9000
EXPOSE 9000
CMD ["bun", "/opt/agentforge/server.js"]
