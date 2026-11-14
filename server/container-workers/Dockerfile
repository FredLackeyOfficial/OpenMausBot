FROM node:26.13.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git && rm -rf /var/lib/apt/lists/*
COPY --chown=root:root dist-server/ /opt/omb/runtime/
RUN test -f /opt/omb/runtime/container-worker.js && test -f /opt/omb/runtime/container-workers/mcp-client.mjs && chmod -R a+rX /opt/omb/runtime
ENV HOME=/home/agent TMPDIR=/tmp OMB_DATA_DIR=/home/agent/.openmausbot
USER node
ENTRYPOINT ["node", "/opt/omb/runtime/container-worker.js"]
