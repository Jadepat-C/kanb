# syntax=docker/dockerfile:1
# Single image: Rust API + built React SPA (served by the same binary).

FROM node:24-alpine AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM rust:1-bookworm AS api
WORKDIR /src
# cache dependencies separately from sources
COPY backend/Cargo.toml backend/Cargo.lock ./
RUN mkdir src && echo 'fn main() {}' > src/main.rs && cargo build --release && rm -rf src target/release/kanban target/release/deps/kanban* target/release/.fingerprint/kanban-*
COPY backend/ ./
# COPY keeps old mtimes, which would make cargo think the placeholder build is still fresh
RUN touch src/main.rs && cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates wget && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --no-create-home kanban
COPY --from=api /src/target/release/kanban /usr/local/bin/kanban
COPY --from=web /web/dist /srv/web
ENV BIND_ADDR=0.0.0.0:8080 \
    STATIC_DIR=/srv/web \
    RUST_LOG=kanban=info,tower_http=warn
USER kanban
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:8080/api/health || exit 1
ENTRYPOINT ["kanban"]
CMD ["serve"]
