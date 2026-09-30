#!/bin/sh
# Registers TEMPORAL_NAMESPACE on the shared server unless it exists, once the
# server answers its health check.
set -eu

: "${TEMPORAL_NAMESPACE:?TEMPORAL_NAMESPACE is required}"
: "${TEMPORAL_ADDRESS:?TEMPORAL_ADDRESS is required}"
MAX_ATTEMPTS=30
SLEEP_SECONDS=2

attempt=1
until temporal operator cluster health --address "$TEMPORAL_ADDRESS" >/dev/null 2>&1; do
  if [ "$attempt" -ge "$MAX_ATTEMPTS" ]; then
    echo "Temporal at $TEMPORAL_ADDRESS was not healthy after $MAX_ATTEMPTS attempts" >&2
    exit 1
  fi
  attempt=$((attempt + 1))
  sleep "$SLEEP_SECONDS"
done

attempt=1
while :; do
  if temporal operator namespace describe -n "$TEMPORAL_NAMESPACE" --address "$TEMPORAL_ADDRESS" >/dev/null 2>&1; then
    echo "Namespace $TEMPORAL_NAMESPACE exists"
    exit 0
  fi
  if temporal operator namespace create -n "$TEMPORAL_NAMESPACE" --address "$TEMPORAL_ADDRESS"; then
    echo "Namespace $TEMPORAL_NAMESPACE created"
    exit 0
  fi
  if [ "$attempt" -ge "$MAX_ATTEMPTS" ]; then
    echo "Could not register namespace $TEMPORAL_NAMESPACE after $MAX_ATTEMPTS attempts" >&2
    exit 1
  fi
  attempt=$((attempt + 1))
  sleep "$SLEEP_SECONDS"
done
