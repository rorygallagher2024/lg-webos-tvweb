#!/bin/bash
# Poll LG webOS TV for SoC temp / CPU load.
# Outputs JSON. Works over rooted telnet on port 23.
# Usage: ./tvstats.sh <tv-ip>

TV="$1"
[ -n "$TV" ] || { echo "usage: $0 <tv-ip>" >&2; exit 2; }

# shellcheck disable=SC2016  # the $(...) below run on the TV, not here
raw=$( { printf '\n'; sleep 1
         printf 'echo S:$(cat /proc/lg/pm/temperature):$(cat /proc/lg/pm/current_load):$(cat /proc/lg/pm/frequency):E\n'
         sleep 2; } | nc -w 5 "$TV" 23 2>/dev/null | tr -d '\r' )

line=$(echo "$raw" | grep -o 'S:[0-9]*:[0-9]*:[0-9]*:E' | tail -1)

if [ -z "$line" ]; then
  echo '{"available": false}'
  exit 1
fi

temp=$(echo "$line" | cut -d: -f2)
load=$(echo "$line" | cut -d: -f3)
freq=$(echo "$line" | cut -d: -f4)

echo "{\"available\": true, \"temperature\": $temp, \"cpu_load\": $load, \"cpu_mhz\": $((freq/1000))}"
