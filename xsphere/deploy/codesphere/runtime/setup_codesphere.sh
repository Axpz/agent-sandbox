#!/bin/bash

# Runtime entrypoint used by the CodeSphere backend after it has assigned the
# sandbox ID and written the bootstrap token. The base image already contains
# the daemon source, Python environment, and Pi runtime.

set -e

WORK_DIR=${WORK_DIR:-/home/user/codesphere-app}
VENV_PYTHON=${VENV_PYTHON:-"$WORK_DIR/.venv/bin/python"}
PY313_BIN=${PY313_BIN:-/usr/local/bin/python3.13}
NODE22_BIN=${NODE22_BIN:-/opt/node22/bin/node}
LIFECYCLE_LOCK=/tmp/codesphere-daemon-lifecycle.lock
SUPERVISOR_PID=/tmp/codesphere-daemon-supervisor.pid

log_info() {
    printf '[INFO] [%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S.%3N')" "$1"
}

log_warn() {
    printf '[WARN] [%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S.%3N')" "$1" >&2
}

log_error() {
    printf '[ERROR] [%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S.%3N')" "$1" >&2
}

hydrate_env_from_pid1() {
    local key value
    for key in \
        CODESPHERE_LISTEN_PORT \
        CODESPHERE_PROJECT_ROOT \
        CODESPHERE_BOOTSTRAP_SECRET_PATH \
        CODESPHERE_LOG_INJECTED_PROMPT \
        SANDBOX_DOMAIN \
        AGENTSPHERE_SANDBOX_ID; do
        [ -n "${!key:-}" ] && continue
        value=$(grep -z "^${key}=" /proc/1/environ 2>/dev/null |
            tr -d '\0' |
            cut -d= -f2- || true)
        if [ -n "$value" ]; then
            export "$key=$value"
        fi
    done
}

supervise_daemon() {
    local environment="$1"
    local log_file="$2"
    local exit_code

    export CODESPHERE_ENV="$environment"
    export CODESPHERE_PI_NODE_BIN="$NODE22_BIN"
    export CODESPHERE_PI_CLI_PATH="$WORK_DIR/pi-runtime/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
    export CODESPHERE_PI_ASK_USER_EXTENSION_PATH="$WORK_DIR/src/daemon/runtime/pi/extension/codesphere-ask-user/index.ts"
    export CODESPHERE_PI_PROVIDER_EXTENSION_PATH="$WORK_DIR/src/daemon/runtime/pi/extension/codesphere-provider/index.ts"
    export LANG=C.UTF-8
    export PYTHONUNBUFFERED=1

    while true; do
        hydrate_env_from_pid1
        log_info "starting daemon (env=$CODESPHERE_ENV listen_port=${CODESPHERE_LISTEN_PORT:-8081} sandbox=${AGENTSPHERE_SANDBOX_ID:-unknown})"

        cd "$WORK_DIR"
        exit_code=0
        "$VENV_PYTHON" scripts/start.py start daemon --env "$environment" \
            >>"$log_file" 2>&1 || exit_code=$?

        log_warn "daemon exited (rc=$exit_code), restarting in 2s"
        sleep 2
    done
}

supervisor_running() {
    pgrep -f '^([^ ]+ )?/usr/local/bin/setup_codesphere[.]sh _supervise( |$)' >/dev/null
}

start_fluent_bit() {
    local environment="$1"

    if [ "${OBSERVABILITY_ENABLED:-true}" != "true" ]; then
        log_info "observability disabled"
        return
    fi
    if [ ! -x /opt/fluent-bit/bin/fluent-bit ]; then
        log_warn "fluent-bit is not installed"
        return
    fi
    if pgrep -x fluent-bit >/dev/null; then
        log_info "fluent-bit already running"
        return
    fi

    sudo chown -R "$(id -u):$(id -g)" /var/lib/fluent-bit 2>/dev/null ||
        log_warn "could not change ownership of /var/lib/fluent-bit"

    export CODESPHERE_ENV="$environment"
    hydrate_env_from_pid1
    export AGENTSPHERE_SANDBOX_ID="${AGENTSPHERE_SANDBOX_ID:-unknown}"
    export FLUENT_BIT_HOST="${FLUENT_BIT_HOST:-10.10.205.50}"
    export FLUENT_BIT_PORT="${FLUENT_BIT_PORT:-24224}"

    /opt/fluent-bit/bin/fluent-bit -c /etc/fluent-bit/fluent-bit.conf \
        >/tmp/fluent-bit.log 2>&1 &
    log_info "fluent-bit started (pid=$!)"
}

start_application() {
    local environment="${1:-private-test}"
    local log_file

    if supervisor_running; then
        log_info "daemon supervisor already running"
        return
    fi

    export CODESPHERE_ENV="$environment"
    sudo chown -R "$(id -u):$(id -g)" \
        /etc/codesphere /mnt/user-data /home/user/.pi 2>/dev/null ||
        log_warn "could not update runtime directory ownership"
    git config --global --add safe.directory "$WORK_DIR" 2>/dev/null || true

    mkdir -p "$WORK_DIR/logs"
    log_file="$WORK_DIR/logs/daemon.$(date +%Y%m%d).log"
    touch "$log_file"

    nohup /usr/local/bin/setup_codesphere.sh _supervise "$environment" "$log_file" \
        >/tmp/daemon-supervisor.log 2>&1 &
    echo $! >"$SUPERVISOR_PID"
    log_info "daemon supervisor started (pid=$!)"

    start_fluent_bit "$environment"
}

stop_matching_processes() {
    local pattern="$1"
    local signal attempt

    for signal in TERM KILL; do
        pkill -"$signal" -f -- "$pattern" 2>/dev/null || true
        for ((attempt = 0; attempt < 50; attempt++)); do
            if ! pgrep -f -- "$pattern" >/dev/null; then
                return
            fi
            sleep 0.1
        done
    done

    log_error "daemon processes did not exit"
    return 1
}

stop_application() {
    stop_matching_processes '^([^ ]+ )?/usr/local/bin/setup_codesphere[.]sh _supervise( |$)'
    stop_matching_processes "^$WORK_DIR/[.]venv/bin/python ($WORK_DIR/)?main[.]py( |$)"
    rm -f "$SUPERVISOR_PID"
    log_info "daemon stopped"
}

restart_application() {
    local environment="${1:-private-test}"

    cd "$WORK_DIR"
    git pull || log_warn "git pull failed; using the existing source"
    rm -f CLAUDE.md
    uv sync --frozen --no-dev --python "$PY313_BIN" ||
        log_warn "uv sync failed; using the existing environment"

    stop_application
    start_application "$environment"
}

usage() {
    cat <<'EOF'
Usage: setup_codesphere.sh start|stop|restart [environment]
EOF
}

main() {
    case "${1:-}" in
        start|stop|restart)
            flock --exclusive --close "$LIFECYCLE_LOCK" "$0" _locked "$@"
            return
            ;;
        _locked)
            shift
            ;;
    esac

    case "${1:-}" in
        start)
            start_application "${2:-private-test}"
            ;;
        stop)
            stop_application
            ;;
        restart)
            restart_application "${2:-private-test}"
            ;;
        _supervise)
            supervise_daemon "${2:?missing environment}" "${3:?missing log file}"
            ;;
        help|--help|-h)
            usage
            ;;
        *)
            usage >&2
            return 1
            ;;
    esac
}

main "$@"
