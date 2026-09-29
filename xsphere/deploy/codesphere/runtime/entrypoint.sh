#!/bin/sh
set -eu

# Start Jupyter only. Backend sandbox.py starts daemon after assigning its ID.
/root/.jupyter/start-up.sh &

# gVisor's checkpoint saves the sentry and application memory but rebuilds the
# netstack on restore, so envd's edge-triggered netpoller never re-learns that
# the listener is ready and accept() blocks forever while the process still
# looks healthy. Only a fresh process image recovers: the postStart hook kills
# the wedged envd and this loop starts its replacement. Upstream e2b gets the
# same behaviour from systemd's Restart=always.
while :; do
	/usr/local/bin/envd -isnotfc -no-cgroups -verbose || true
	# Keep a permanently failing envd from spinning the CPU.
	sleep 1
done
