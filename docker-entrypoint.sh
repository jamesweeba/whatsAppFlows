#!/bin/sh
set -e

echo "Running database migrations..."
./node_modules/.bin/prisma migrate deploy

echo "Starting WhatsApp Flows backend..."
exec node dist/main.js
