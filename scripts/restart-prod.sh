#!/bin/bash
# Restart the PRODUCTION standalone server on :3000 (Caddy proxies it).
# The dev server (Turbopack) OOMs in this 4GB sandbox after ~10 SSR loads,
# so the preview runs from the production build instead. TiDB clusters
# are not touched.
cd /home/z/my-project

pkill -f ".next/standalone/server.js" 2>/dev/null
sleep 1

setsid nohup env NODE_ENV=production bun /home/z/my-project/.next/standalone/server.js \
  < /dev/null >> /home/z/my-project/server.log 2>&1 &

for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://localhost:3000/ 2>/dev/null)
  if [ "$code" = "200" ]; then
    echo "PRODUCTION SERVER READY (attempt $i)"
    exit 0
  fi
  sleep 2
done
echo "PRODUCTION SERVER FAILED TO START"
exit 1
