#!/bin/bash
# Soft restart: kill + relaunch the dev server WITHOUT clearing .next
# (restart-dev.sh clears the cache and forces a full recompile, which
# costs ~1.5GB peak memory in this 4GB sandbox).
cd /home/z/my-project
pkill -f "next dev" 2>/dev/null
pkill -f "zscripts/dev.sh" 2>/dev/null
sleep 2
setsid nohup bash .zscripts/dev.sh < /dev/null >> .zscripts/dev-launch.log 2>&1 &
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
