# AgentForge's server on AgentCore, running the model-free procedures of
# integ/local/runtime from source. FROM the base image the package ships,
# built first by the test, which already carries every package the source
# imports; the manifest is copied only for its `#core/*` imports.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
WORKDIR /agentic/agent
COPY --chown=bun source/ ./
ENV AGENTFORGE_AGENT_NAME=runtime-integ
CMD ["bun", "integ/aws/agentcore/__fixtures__/agentforge-server.ts"]
