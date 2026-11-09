# TG Vault 一键更新代理（host 侧边车）。
# 只含 docker/compose 客户端，不含 daemon；daemon 通过挂载的 socket 访问。
# 固定版本：alpine 3.20 + docker-cli 26.1.5 + docker-cli-compose 2.27.0
# （alpine v3.20 community 仓库实测版本号）。
FROM alpine:3.20

RUN apk add --no-cache \
        docker-cli=26.1.5-r0 \
        docker-cli-compose=2.27.0-r3 \
        git \
        bash \
        curl \
        jq \
    && docker --version \
    && docker compose version

COPY updater.sh /usr/local/bin/updater.sh
RUN chmod 0755 /usr/local/bin/updater.sh

ENTRYPOINT ["/usr/local/bin/updater.sh"]
