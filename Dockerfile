FROM node:20-alpine

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY src/ ./src/
COPY public/ ./public/

ENV PORT=3000
ENV DATA_DIR=/data
ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "src/server.js"]
