#!/bin/sh
# Transport for the c8y-deploy-poll flow. All decisions are made by the flow step,
# this script only executes the request published by the step once it is due.
#
# Usage:
#   poll.sh request <request_topic> <state_dir>
#       Read the retained request "<due> <expires> <id> <path> <body>" and send it
#       once it is due. Prints one JSON line with the result, or nothing.
#   poll.sh context <file>
#       Print the contents of the JSON file on a single line (nothing if missing)
#   poll.sh detect
#       Print information about the device used to build the device context, e.g.
#       {"machine":"aarch64","dpkg":"arm64"}. The values are normalized by the flow
#
# The script always exits with 0, as the flow drops the output of failed commands.

# Escape a string so that it can be used as a JSON string value
json_escape() {
    printf '%s' "$1" | tr -d '\r' | tr '\n\t' '  ' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

cmd_request() {
    topic="$1"
    state_dir="$2"

    line=$(tedge mqtt sub "$topic" -C 1 -W 1 --no-topic 2>/dev/null)
    [ -n "$line" ] || return 0

    # The body is the rest of the line, so it can contain spaces
    read -r due expires id path body <<EOF
$line
EOF
    [ -n "$id" ] && [ -n "$path" ] || return 0

    now=$(date +%s)
    [ "$now" -ge "$due" ] 2>/dev/null || return 0
    if [ "$expires" -gt 0 ] 2>/dev/null && [ "$now" -gt "$expires" ]; then
        return 0
    fi

    # Execute each request at most once
    mkdir -p "$state_dir" 2>/dev/null
    state_file="$state_dir/$(printf '%s' "$topic" | tr '/' '_').last"
    if [ -f "$state_file" ] && [ "$(cat "$state_file")" = "$id" ]; then
        return 0
    fi
    printf '%s' "$id" > "$state_file"

    [ -n "$body" ] || body="{}"
    err_file="$state_dir/.stderr.$$"
    if response=$(tedge http post "$path" --data "$body" --content-type application/json 2>"$err_file"); then
        printf '{"id":"%s","path":"%s","ok":true,"response":"%s"}\n' \
            "$(json_escape "$id")" "$(json_escape "$path")" "$(json_escape "$response")"
    else
        printf '{"id":"%s","path":"%s","ok":false,"error":"%s"}\n' \
            "$(json_escape "$id")" "$(json_escape "$path")" "$(json_escape "$(cat "$err_file")")"
    fi
    rm -f "$err_file"
}

cmd_context() {
    file="$1"
    [ -n "$file" ] && [ -f "$file" ] || return 0
    tr -d '\r\n' < "$file"
    echo
}

cmd_detect() {
    machine=$(uname -m 2>/dev/null)
    dpkg_arch=""
    if command -v dpkg >/dev/null 2>&1; then
        dpkg_arch=$(dpkg --print-architecture 2>/dev/null)
    fi
    printf '{"machine":"%s","dpkg":"%s"}\n' "$(json_escape "$machine")" "$(json_escape "$dpkg_arch")"
}

case "$1" in
    request) shift; cmd_request "$@" ;;
    context) shift; cmd_context "$@" ;;
    detect) shift; cmd_detect "$@" ;;
    *) echo "Usage: $0 request <topic> <state_dir> | context <file> | detect" >&2 ;;
esac
exit 0
