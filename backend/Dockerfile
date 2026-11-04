# Backend images for the local Docker deployment (docker compose up -d --build, built from the repository root).
# UAT/production images are built by the pipeline.
#   build: backend workspace with dev dependencies; also runs migrations and the DWS Hub dev stub
#   api:   compiled API with production dependencies only

FROM node:22.20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN npm ci -w @ecr/api
COPY backend ./backend
RUN npm run build -w @ecr/api

FROM node:22.20-bookworm-slim AS api
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN npm ci --omit=dev -w @ecr/api && npm cache clean --force
COPY --from=build /app/backend/dist backend/dist
COPY backend/migrations backend/migrations
WORKDIR /app/backend
RUN mkdir -p var/storage && chown -R node:node var
USER node
EXPOSE 3100
CMD ["node", "dist/main.js"]
