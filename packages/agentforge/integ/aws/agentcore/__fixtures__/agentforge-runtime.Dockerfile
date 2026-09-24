# AgentForge's server on AgentCore, running the model-free procedures of
# integ/local/runtime. FROM the base image the package ships, built first by
# the test; dependencies from the workspace lockfile, source run by Bun.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
WORKDIR /home/bun/app
COPY --chown=bun workspace/ ./
RUN bun install --frozen-lockfile --linker hoisted --filter @beruangai/agentforge
COPY --chown=bun source/ packages/agentforge/
WORKDIR /home/bun/app/packages/agentforge
ENV AGENTFORGE_AGENT_NAME=runtime-integ \
    AGENTFORGE_TASK_COMMAND='["bun","integ/local/runtime/__fixtures__/task-entry.ts"]'
CMD ["bun", "integ/aws/agentcore/__fixtures__/agentforge-server.ts"]
