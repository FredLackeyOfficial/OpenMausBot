FROM node:26.13.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git && rm -rf /var/lib/apt/lists/*
RUN npm install --global @openai/codex@0.169.0 && npm cache clean --force
USER node
ENTRYPOINT ["codex"]
