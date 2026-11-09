#!/usr/bin/env bash
# Production FE server (172.28.80.50), at the release to deploy:  sudo bash frontend/deploy/deploy-prod.sh  (docs/DEPLOY-PROD.md)
exec bash "$(dirname "$0")/deploy.sh" prod
