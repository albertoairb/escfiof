FROM node:20-alpine

WORKDIR /app

COPY package*.json /app/
RUN npm config set registry https://registry.npmjs.org/ \
    && npm config set fetch-retries 5 \
    && npm config set fetch-retry-mintimeout 20000 \
    && npm config set fetch-retry-maxtimeout 120000 \
    && npm ci --omit=dev

COPY server.js /app/server.js
COPY public /app/public

ENV NODE_ENV=production
EXPOSE 8080

CMD ["npm","start"]
