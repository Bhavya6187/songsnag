# Node runs the TypeScript sources directly, so there is no build step.
FROM node:24-slim

# yt-dlp downloads shared reels from their public page; ffmpeg cuts frames and
# audio out of them. The yt-dlp version is pinned so a rebuild cannot change
# behaviour by surprise. Instagram changes its pages often: when downloads
# start failing for every reel, raise this version first.
ARG YT_DLP_VERSION=2026.10.26
ARG TARGETARCH
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg \
 && case "${TARGETARCH}" in arm64) asset=yt-dlp_linux_aarch64 ;; *) asset=yt-dlp_linux ;; esac \
 && curl -fsSL -o /usr/local/bin/yt-dlp \
      "https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}/${asset}" \
 && chmod 755 /usr/local/bin/yt-dlp \
 && apt-get purge -y curl && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
# better-sqlite3 ships its compiled binaries inside the package. Without
# --ignore-scripts npm tries to compile it again, which needs Python and a
# compiler that this image does not have.
RUN npm ci --omit=dev --ignore-scripts

COPY src ./src
# Not used by the server: scripts/user-delete.ts is run by hand in the container.
COPY scripts ./scripts

# The SQLite database. Mount a volume here, or it is lost on every deploy.
RUN mkdir /data && chown node:node /data
ENV DATABASE_PATH=/data/songsnag.db

USER node
ENV PORT=3000
EXPOSE 3000

# Configuration comes from the host's environment variables, not a .env file.
CMD ["node", "src/server.ts"]
