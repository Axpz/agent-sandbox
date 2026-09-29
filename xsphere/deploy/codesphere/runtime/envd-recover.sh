#!/bin/sh
# Runtime postStart hook: restart envd if its accept loop came back wedged from
# a gVisor restore. The entrypoint supervisor starts a fresh envd after the kill.
#
# Bounded and always exits 0 -- kubelet holds the container out of Running
# until postStart returns, so a hook that fails or hangs is worse than the
# wedge it repairs.
set -u

readonly HEALTH_URL="http://127.0.0.1:49983/health"
# A restored envd never answers rather than answering slowly, so this only has
# to cover a cold start's bind time -- and every second of it is added to the
# resume latency the Edge ensure-running subrequest is waiting on.
readonly WAIT_SECONDS=15

wait_healthy() {
	i=0
	while [ "$i" -lt "$WAIT_SECONDS" ]; do
		if curl -sf -o /dev/null -m 1 "$HEALTH_URL"; then
			return 0
		fi
		i=$((i + 1))
		sleep 1
	done
	return 1
}

if wait_healthy; then
	exit 0
fi

echo "envd did not answer /health within ${WAIT_SECONDS}s; restarting it" >&2
pkill -x envd || true

if ! wait_healthy; then
	echo "envd still not answering /health after restart" >&2
fi

exit 0
