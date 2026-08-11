# ─── Build stage ──────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY db ./db
COPY scripts ./scripts
RUN npm run build

# ─── Development stage (docker-compose) ───────────────────────────────────────
FROM node:20-alpine AS development
WORKDIR /app
ENV NODE_ENV=development
COPY package*.json ./
RUN npm ci
EXPOSE 3000
CMD ["npm", "run", "dev"]

# ─── Production stage ─────────────────────────────────────────────────────────
FROM node:20-alpine AS production
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/db ./db
# The migration runner (plain JS, production deps only) — Railway's pre-deploy
# command runs `npm run db:migrate` in this image before each deploy goes live.
COPY --from=builder /app/scripts ./scripts
EXPOSE 3000
USER node
CMD ["node", "dist/api/server.js"]
