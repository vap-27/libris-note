#!/bin/bash
# Cleanly restart the Next.js dev server (clears possibly-corrupted Turbopack cache).
# TiDB clusters are NOT touched (data persists independently).
cd /home/z/my-project

# stop old server (avoid dev.sh trap - we kill the pipeline directly)
pkill -f "tee dev.log" 2>/dev/null
pkill -f "next dev" 2>/dev/null
pkill -f "zscripts/dev.sh" 2>/dev/null
sleep 2

# clear potentially corrupted turbopack cache
rm -rf .next

# relaunch via the platform script (proven to survive across sessions)
setsid nohup bash .zscripts/dev.sh < /dev/null >> .zscripts/dev-launch.log 2>&1 &

# wait for readiness
for i in $(seq 1 45); do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 http://localhost:3000/ 2>/dev/null)
  if [ "$code" = "200" ]; then
    echo "DEV SERVER READY (attempt $i)"
    exit 0
  fi
  sleep 2
done
echo "DEV SERVER FAILED TO START"
exit 1
