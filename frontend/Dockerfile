# Frontend image for the local Docker deployment (docker compose up -d --build, built from the repository root):
# the built web app behind nginx, which proxies /api to the backend. UAT/production images are built by the pipeline.

FROM node:22.20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN npm ci -w @ecr/web
COPY frontend ./frontend
# DWS Hub SDK (optional): script address, the application's key from Hub Admin → SDK, and the release for Sentinel.
ARG VITE_HUB_SDK_URL=
ARG VITE_HUB_SDK_KEY=
ARG VITE_GIT_SHA=
RUN VITE_HUB_SDK_URL="$VITE_HUB_SDK_URL" VITE_HUB_SDK_KEY="$VITE_HUB_SDK_KEY" VITE_GIT_SHA="$VITE_GIT_SHA" npm run build -w @ecr/web

FROM nginx:1.27-alpine AS web
# Where /api goes; the image's entrypoint writes the template to conf.d with this filled in.
ENV ECR_API_UPSTREAM=http://api:3100
COPY frontend/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/frontend/dist /usr/share/nginx/html
