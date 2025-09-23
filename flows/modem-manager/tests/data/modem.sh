#!/bin/sh
set -e
SIMULATE=${SIMULATE:-0}
INTERVAL=${INTERVAL:-60}
OUTPUT=${OUTPUT:-mqtt}
TOPIC=${TOPIC:-"te/device/main///source/modemManager"}

dir=$(CDPATH="" cd -- "$(dirname -- "$0")" && pwd)

SUDO=
if [ "$(id -u)" != 0 ]; then
    if command -V sudo >/dev/null 2>&1; then
        SUDO=sudo
    fi
fi

collect() {
    if [ "$SIMULATE" = 1 ]; then
        echo "Using simulated data" >&2
        SIM=$(cat "$dir/sim.json")
        LOCATION=$(cat "$dir/location.json")
        MODEM=$(cat "$dir/modem.json")
    else
        MODEM=$($SUDO mmcli --modem any -J || echo '{}')
        SIM=$($SUDO mmcli --sim any -J || echo '{}')
        LOCATION=$($SUDO mmcli --modem any --location-get -J || echo '{}')
    fi

    case "$OUTPUT" in
        stdout)
            echo "$SIM" "$LOCATION" "$MODEM" | jq -s '.[0] * .[1] * .[2]'
            ;;
        mqtt)
            PAYLOAD=$(echo "$SIM" "$LOCATION" "$MODEM" | jq -s '.[0] * .[1] * .[2]')
            tedge mqtt pub "$TOPIC" "$PAYLOAD"
            ;;
    esac
}

usage() {
    cat <<EOT
Get modem information from modem manager

$0 [--interval <sec>] [--topic <topic>]

ARGUMENTS
  --interval <sec>          Collect the modem information every x seconds
                            Default: 60
  --topic <topic>           MQTT Topic to publish the modem information to.
                            Default: te/device/main///source/modemManager
  --output <stdout|mqtt>    Where to output the messages to.
                            Default: mqtt

EXAMPLES
  $0 --interval 60 --topic te/device/main///source/modemManager --output mqtt
  Publish modem information every 60 seconds to the te/device/main///source/modemManager topic

  $0 --output stdout --interval 0
  Get modem information once and print out to stdout
EOT
}

while [ $# -gt 0 ]; do
    case "$1" in
        --interval)
            INTERVAL="$2"
            shift
            ;;
        --output)
            OUTPUT="$2"
            shift
            ;;
        --topic)
            TOPIC="$2"
            shift
            ;;
        --help|-h)
            usage
            exit 0
            ;;
    esac
    shift
done

if [ "$INTERVAL" -gt 0 ]; then
    while true; do
        collect
        sleep "$INTERVAL"
    done
else
    collect
fi
