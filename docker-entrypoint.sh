#!/bin/sh
set -e

env_or() {
  # prefers RWP_* then plain
  var_name="$1"
  default="$2"
  rwp_name="RWP_${var_name}"
  eval val=\${$rwp_name:-}
  if [ -z "$val" ]; then
    eval val=\${$var_name:-}
  fi
  if [ -z "$val" ]; then
    val="$default"
  fi
  echo "$val"
}

ROLE="$(env_or ROLE server)"
TRANSPORT="$(env_or TRANSPORT auto)"
INSECURE_FLAG=""
DEBUG_FLAG=""

INSECURE="$(env_or INSECURE false)"
DEBUG="$(env_or DEBUG false)"

if [ "$INSECURE" = "true" ] || [ "$INSECURE" = "1" ]; then
  INSECURE_FLAG="--insecure"
fi
if [ "$DEBUG" = "true" ] || [ "$DEBUG" = "1" ]; then
  DEBUG_FLAG="--debug"
fi

case "$ROLE" in
  server)
    PORT="$(env_or PORT 8080)"
    HOST="$(env_or HOST 0.0.0.0)"
    exec node bin/rwp.js server --port "$PORT" --host "$HOST"
    ;;
  lan)
    SERVER_URL="$(env_or SERVER_URL '')"
    SESSION="$(env_or SESSION '')"
    if [ -z "$SERVER_URL" ] || [ -z "$SESSION" ]; then
      echo "SERVER_URL and SESSION (or RWP_SERVER_URL/RWP_SESSION) are required for lan role" >&2
      exit 1
    fi
    PROXY="$(env_or PROXY '')"
    PROXY_ARGS=""
    if [ -n "$PROXY" ]; then
      PROXY_ARGS="--proxy $PROXY"
    fi
    TUNNEL_PROXY="$(env_or TUNNEL_PROXY '')"
    TUNNEL_PROXY_ARGS=""
    if [ -n "$TUNNEL_PROXY" ]; then
      TUNNEL_PROXY_ARGS="--tunnel-proxy $TUNNEL_PROXY"
    fi
    exec node bin/rwp.js lan --transport "$TRANSPORT" $INSECURE_FLAG $DEBUG_FLAG $PROXY_ARGS $TUNNEL_PROXY_ARGS "$SESSION" "$SERVER_URL"
    ;;
  proxy)
    SERVER_URL="$(env_or SERVER_URL '')"
    SESSION="$(env_or SESSION '')"
    if [ -z "$SERVER_URL" ] || [ -z "$SESSION" ]; then
      echo "SERVER_URL and SESSION (or RWP_SERVER_URL/RWP_SESSION) are required for proxy role" >&2
      exit 1
    fi
    PORT="$(env_or PROXY_PORT 3128)"
    HOST="$(env_or PROXY_HOST 0.0.0.0)"
    PROXY="$(env_or PROXY '')"
    PROXY_ARGS=""
    if [ -n "$PROXY" ]; then
      PROXY_ARGS="--proxy $PROXY"
    fi
    exec node bin/rwp.js proxy --transport "$TRANSPORT" $INSECURE_FLAG $DEBUG_FLAG $PROXY_ARGS "$SESSION" "$SERVER_URL" "$PORT" --host "$HOST"
    ;;
  *)
    echo "Unknown RWP_ROLE: $ROLE" >&2
    exit 1
    ;;
esac
