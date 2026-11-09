#!/usr/bin/env bash
# Staging FE server (172.28.92.56):  cd /opt/export-charges && sudo git pull --ff-only && sudo bash frontend/deploy/deploy-staging.sh
exec bash "$(dirname "$0")/deploy.sh" staging
