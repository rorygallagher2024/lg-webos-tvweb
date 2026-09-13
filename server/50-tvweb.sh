#!/bin/sh
# webosbrew boot hook: start the tvweb monitor server.
# Install to /var/lib/webosbrew/init.d/50-tvweb (chmod +x).
# Note: BusyBox run-parts ignores filenames containing a dot (.),
# so this hook must not have a .sh extension in init.d.
# Remove /var/lib/webosbrew/init.d/50-tvweb to uninstall.
# Nothing on the read-only rootfs is touched.
#
# Deliberately defensive: never block boot, never respawn-loop. If the
# server is missing or node is gone, this exits quietly.

[ -x /usr/bin/node ] || exit 0
[ -f /var/lib/tvweb/tvweb.js ] || exit 0

export PATH="/bin:/sbin:/usr/bin:/usr/sbin:$PATH"

# Hold down the LG daemons switched off in the dashboard. Done in the delayed
# block below, after upstart has had its go at starting them.

# Restore adblock bind-mount if enabled
if [ -f /var/lib/tvweb/adblock_enabled ] && [ -f /var/lib/tvweb/adblock_hosts ]; then
  mount --bind /var/lib/tvweb/adblock_hosts /etc/hosts 2>/dev/null || true
fi

# Restore the chosen screen saver. The app directory is on the read-only
# overlay, so the replacement is a bind mount and does not survive a reboot.
if [ -f /var/lib/tvweb/screensaver/.tvweb-screensaver ]; then
  mount --bind /var/lib/tvweb/screensaver \
        /usr/palm/applications/com.webos.app.screensaver 2>/dev/null || true
fi

# Detach fully so upstart/webosbrew startup is never held up by this.
# Prefer tvwebctl: it starts the watchdog alongside the server. The direct
# line stays as a fallback for installs that predate that script.
(
  sleep 20   # let the TV finish booting before adding load
  /usr/bin/pkill -9 -f tvweb.js 2>/dev/null || true
  sleep 1
  if [ -f /var/lib/tvweb/services_stopped ]; then
    while read -r job; do
      [ -n "$job" ] && /sbin/initctl stop "$job" >/dev/null 2>&1
    done < /var/lib/tvweb/services_stopped
  fi

  if [ -x /var/lib/tvweb/tvwebctl ]; then
    /var/lib/tvweb/tvwebctl start
  else
    setsid /usr/bin/node /var/lib/tvweb/tvweb.js \
      > /var/lib/tvweb/tvweb.log 2>&1 &
  fi
) &

exit 0
