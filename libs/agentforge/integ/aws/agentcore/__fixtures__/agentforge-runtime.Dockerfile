# AgentForge's server on AgentCore, running the model-free procedures of
# integ/local/runtime from source. FROM the base image the package ships,
# built first by the test. The source sits beside the bundle, inside the
# `agentforge` member, so it resolves AgentForge's own dependencies and the
# workspace's peers as the bundle does; its manifest serves `#core/*`.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
COPY --chown=bun source/ /workspace/agentforge/source/
ENV AGENTFORGE_AGENT_NAME=runtime-integ
CMD ["bun", "/workspace/agentforge/source/integ/aws/agentcore/__fixtures__/agentforge-server.ts"]
