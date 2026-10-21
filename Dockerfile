FROM node:20-alpine
RUN apk add --no-cache bash curl jq
WORKDIR /app
COPY docker/server.js /app/server.js
COPY docker/public /app/public
COPY cf-deploy.sh /app/cf/cf-deploy.sh
RUN chmod +x /app/cf/cf-deploy.sh && \
    mkdir -p /app/js /app/cf/backup /app/cf/logs
EXPOSE 5004
ENV PORT=5004
ENV WEB_PASSWORD=admin123
CMD ["node", "/app/server.js"]
