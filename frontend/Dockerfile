# Frontend image for the local Docker deployment (docker compose up -d --build, built from the repository root):
# the built web app behind nginx, which proxies /api to the backend. UAT/production images are built by the pipeline.

FROM node:22.20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN npm ci -w @ecr/web
COPY frontend ./frontend
RUN npm run build -w @ecr/web

FROM nginx:1.27-alpine AS web
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/frontend/dist /usr/share/nginx/html
