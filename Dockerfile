# 零依赖：不需要 npm install，镜像里只有 Node 运行时和源码
FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DATA_DIR=/data

WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1

CMD ["node", "--disable-warning=ExperimentalWarning", "server/server.js"]
