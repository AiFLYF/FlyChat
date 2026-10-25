# 构建阶段：装依赖 + 编译前端
FROM node:22-alpine AS build
WORKDIR /app

# 先只拷依赖清单，利用 Docker 层缓存：改代码不用重装依赖
COPY package.json package-lock.json ./
# --ignore-scripts：esbuild 的 postinstall 在受限环境里经常失败，
# 它的平台二进制由 @esbuild/linux-x64 这类 optionalDependencies 提供，不跑脚本也能用
RUN npm install --ignore-scripts --no-audit --no-fund

COPY . .
RUN npm run build

# 运行阶段：只要产物与运行期依赖
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001 \
    FLYCHAT_DATA_DIR=/data \
    LOG_FORMAT=json

# 非 root 运行
RUN addgroup -S flychat && adduser -S flychat -G flychat && mkdir -p /data && chown flychat:flychat /data

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/server ./server

USER flychat
VOLUME ["/data"]
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
