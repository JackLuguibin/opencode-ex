# One source image for the Auth gateway and the execution layers (they differ only by command), and a web image that
# serves the built app and proxies /api to the gateway.
#   docker build -f deploy/Dockerfile --target app -t opencode-ex-app .
#   docker build -f deploy/Dockerfile --target web -t opencode-ex-web .
FROM oven/bun:1.4.4-debian AS build
# Execution layers run shell commands and git for users, so the tools they expect have to be in the image.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ripgrep ca-certificates python3 make g++ curl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile --ignore-scripts && bun run --cwd packages/core fix-node-pty
RUN bun run --cwd packages/app build

FROM build AS app
ENV XDG_DATA_HOME=/data/data XDG_CONFIG_HOME=/data/config XDG_STATE_HOME=/data/state XDG_CACHE_HOME=/data/cache
VOLUME /data
EXPOSE 4096 4100

FROM nginx:1.27-alpine AS web
COPY --from=build /app/packages/app/dist /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
