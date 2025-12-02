#!/bin/sh
set -e

ROLE="${RWP_ROLE:-server}"
TRANSPORT="${RWP_TRANSPORT:-auto}"
INSECURE_FLAG=""
DEBUG_FLAG=""

if [ "${RWP_INSECURE}" = "true" ] || [ "${RWP_INSECURE}" = "1" ]; then
  INSECURE_FLAG="--insecure"
fi
if [ "${RWP_DEBUG}" = "true" ] || [ "${RWP_DEBUG}" = "1" ]; then
  DEBUG_FLAG="--debug"
fi

case "$ROLE" in
  server)
    PORT="${RWP_PORT:-8080}"
    HOST="${RWP_HOST:-0.0.0.0}"
    exec node bin/rwp.js server --port "$PORT" --host "$HOST"
    ;;
  lan)
    if [ -z "$RWP_SERVER_URL" ] || [ -z "$RWP_SESSION" ]; then
      echo "RWP_SERVER_URL and RWP_SESSION are required for lan role" >&2
      exit 1
    fi
    PROXY_ARGS=""
    if [ -n "$RWP_PROXY" ]; then
      PROXY_ARGS="--proxy $RWP_PROXY"
    fi
    TUNNEL_PROXY_ARGS=""
    if [ -n "$RWP_TUNNEL_PROXY" ]; then
      TUNNEL_PROXY_ARGS="--tunnel-proxy $RWP_TUNNEL_PROXY"
    fi
    exec node bin/rwp.js lan --transport "$TRANSPORT" $INSECURE_FLAG $DEBUG_FLAG $PROXY_ARGS $TUNNEL_PROXY_ARGS "$RWP_SESSION" "$RWP_SERVER_URL"
    ;;
  proxy)
    if [ -z "$RWP_SERVER_URL" ] || [ -z "$RWP_SESSION" ]; then
      echo "RWP_SERVER_URL and RWP_SESSION are required for proxy role" >&2
      exit 1
    fi
    PORT="${RWP_PROXY_PORT:-3128}"
    HOST="${RWP_PROXY_HOST:-0.0.0.0}"
    PROXY_ARGS=""
    if [ -n "$RWP_PROXY" ]; then
      PROXY_ARGS="--proxy $RWP_PROXY"
    fi
    exec node bin/rwp.js proxy --transport "$TRANSPORT" $INSECURE_FLAG $DEBUG_FLAG $PROXY_ARGS "$RWP_SESSION" "$RWP_SERVER_URL" "$PORT" --host "$HOST"
    ;;
  *)
    echo "Unknown RWP_ROLE: $ROLE" >&2
    exit 1
    ;;
esac
