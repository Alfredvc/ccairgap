FROM node:20-slim
ARG HOST_UID=1000
ARG HOST_GID=1000
RUN apt-get update && apt-get install -y --no-install-recommends git rsync jq ca-certificates && rm -rf /var/lib/apt/lists/*
RUN groupadd -g ${HOST_GID} claude && useradd -m -u ${HOST_UID} -g ${HOST_GID} claude
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
USER claude
ENTRYPOINT ["/entrypoint.sh"]
