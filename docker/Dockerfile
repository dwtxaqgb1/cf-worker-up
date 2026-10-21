FROM node:20-alpine

RUN apk add --no-cache bash curl jq

WORKDIR /app

COPY server.js /app/server.js
COPY public /app/public

EXPOSE 5004

CMD ["node", "/app/server.js"]
