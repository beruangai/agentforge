# {consumer}/{project}/{agent} — one agent's own build.
#
# Its procedures bundled with the harness. A change here must move THIS image
# and no other.
ARG AGENTIC_BASE_IMAGE
FROM ${AGENTIC_BASE_IMAGE}

COPY --chown=0:0 procedures/ /opt/agentforge/procedures/
