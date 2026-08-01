# Build client, then run cloud server that serves dist/ + API
FROM node:22-alpine AS client
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.ts tsconfig*.json ./
COPY public ./public
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app/server
COPY server/package.json ./
RUN npm install --omit=dev
COPY server/src ./src
COPY --from=client /app/dist /app/dist
ENV PORT=8787
ENV NODE_ENV=production
EXPOSE 8787
CMD ["node", "src/index.js"]
