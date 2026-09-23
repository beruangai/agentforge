# agentforge/a2a-claude — the base image.
#
# Carries the server and only the server (ARCHITECTURE.md §6). Its external
# base is pinned by digest (`integ/__fixtures__/pinned-base-image.ts`), never by a moving
# tag: a tag that moves makes every image above it move too.
ARG BUN_IMAGE
FROM ${BUN_IMAGE}

# Deterministic: a fixed, numeric owner rather than a name resolved at build
# time, and no `apk upgrade` — an unpinned package index is the other common
# way a rebuild stops being reproducible.
WORKDIR /opt/agentforge

COPY --chown=0:0 server/ /opt/agentforge/server/

ENV A2A_PORT=9000
EXPOSE 9000
CMD ["bun", "/opt/agentforge/server/server.js"]
