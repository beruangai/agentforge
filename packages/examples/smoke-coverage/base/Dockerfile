# check=skip=InvalidDefaultArgInFrom
# Detached from @beruangai/agentforge (project.json metadata.agentforge.detached):
# `nx sync` leaves this file as written, and AgentForge's updates to the
# maintained lines below are ours to carry.
#
# The agentic image: the project's base layer at /workspace/agentic, on the
# AgentForge image. `agentic/$claude/` becomes its `.claude/`, which every
# agent's session composes from its cwd below. The layer's lock is the whole
# workspace's up to it, so the install adds only what this layer adds.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
# Python and NautilusTrader for every agent in the project, before the layer's
# own files so it is cached across their changes. Installed as root into a
# venv (Debian's system Python is externally managed), from prebuilt wheels
# only, so a wheel missing for the platform fails the build rather than
# compiling; then back to bun, since the CLI refuses unattended tools as root.
# NautilusTrader's Rust extension links libpython, which Debian ships apart.
USER root
RUN apt-get update \
 && apt-get install --yes --no-install-recommends python3 python3-venv libpython3.13 \
 && rm -rf /var/lib/apt/lists/* \
 && python3 -m venv /opt/python \
 && /opt/python/bin/pip install --no-cache-dir --only-binary=:all: nautilus_trader==1.231.0
USER bun
ENV PATH=/opt/python/bin:${PATH}
# A plugin at Claude's user scope, which the base image owns: installed from
# the layer's own marketplace, kept in the image as its source, with the CLI
# the Agent SDK brings. Every run loads it through the `user` setting source,
# a run resumed from the store included.
COPY --chown=bun marketplace/ /opt/smoke-coverage-marketplace/
RUN set -- /workspace/node_modules/.bun/@anthropic-ai+claude-agent-sdk-linux-arm64@*/node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64/claude \
 && [ "$#" -eq 1 ] && [ -x "$1" ] \
 && "$1" plugin marketplace add /opt/smoke-coverage-marketplace \
 && "$1" plugin install user-scope-probe@smoke-coverage --scope user
COPY --chown=bun --exclude=bun.lock --exclude=\$claude agentic/ /workspace/agentic/
COPY --chown=bun agentic/\$claude/ /workspace/agentic/.claude/
COPY --chown=bun agentic/bun.lock /workspace/bun.lock
RUN bun install --cwd /workspace --frozen-lockfile --production
