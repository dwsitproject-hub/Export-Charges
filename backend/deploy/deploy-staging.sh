#!/usr/bin/env bash
# Staging BE server (172.28.92.57):  cd /opt/export-charges && sudo git pull --ff-only && sudo bash backend/deploy/deploy-staging.sh
exec bash "$(dirname "$0")/deploy.sh" staging
