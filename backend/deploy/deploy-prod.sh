#!/usr/bin/env bash
# Production BE server (172.28.80.51), at the release to deploy:  sudo bash backend/deploy/deploy-prod.sh  (docs/DEPLOY-PROD.md)
exec bash "$(dirname "$0")/deploy.sh" prod
