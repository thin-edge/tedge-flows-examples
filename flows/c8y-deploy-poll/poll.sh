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
#       {"machine":"aarch64","os_arch":"dpkg:arm64","pkg":"dpkg rpm","os":"debian","fw":"rugix-ctrl"},
#       where os_arch is "<tool>:<architecture of the OS>" reported by the package
#       manager (opkg: all its architectures, highest priority first), pkg and fw list
#       the package and firmware update tools found and os is the ID from
#       /etc/os-release. The values are normalized by the flow
#
# The script always exits with 0, as the flow drops the output of failed commands.

# Escape a string so that it can be used as a JSON string value
json_escape() {
    printf '%s' "$1" | tr -d '\r' | tr '\n\t' '  ' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

# Send the request via the local Cumulocity proxy. The proxy returns a 502 when
# the connection to Cumulocity was closed while sending the request
# (https://github.com/thin-edge/thin-edge.io/issues/4364), which usually works
# again straight away. Only dry runs are retried: an operation request might have
# reached the server, and is followed by a new dry run by the flow anyway
post() {
    path="$1"
    body="$2"
    err_file="$3"
    if tedge http post "$path" --data "$body" --content-type application/json 2>"$err_file"; then
        return 0
    fi
    case "$path" in
        *createOperation=true*) return 1 ;;
    esac
    grep -q "502" "$err_file" && grep -q "Error communicating with Cumulocity" "$err_file" || return 1
    sleep 1
    tedge http post "$path" --data "$body" --content-type application/json 2>"$err_file"
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
    if response=$(post "$path" "$body" "$err_file"); then
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

# Print the architecture of the OS reported by a package manager, e.g. "arm64".
# Prints nothing if the tool is missing or does not support the query, e.g. the
# dpkg and rpm applets of BusyBox
os_arch_of() {
    command -v "$1" >/dev/null 2>&1 || return 0
    case "$1" in
        dpkg) dpkg --print-architecture 2>/dev/null ;;
        apk) apk --print-arch 2>/dev/null ;;
        # Lines of "arch <name> <priority>": all names, highest priority first
        opkg) opkg print-architecture 2>/dev/null |
            awk '$1 == "arch" { print $3, $2 }' | sort -rn | awk '{ print $2 }' | tr '\n' ' ' ;;
        rpm) rpm --eval '%{_arch}' 2>/dev/null ;;
    esac
}

cmd_detect() {
    machine=$(uname -m 2>/dev/null)
    # Package managers in order of preference. The first one provides os_arch
    os_arch=""
    pkg=""
    for tool in dpkg apk opkg rpm; do
        arch=$(os_arch_of "$tool" | tr -d '\r\n')
        case "$arch" in
            ''|*%*) continue ;;
        esac
        pkg="${pkg:+$pkg }$tool"
        [ -n "$os_arch" ] || os_arch="$tool:$arch"
    done
    fw=""
    for tool in rugix-ctrl mender-update mender rauc swupdate; do
        if command -v "$tool" >/dev/null 2>&1; then
            fw="${fw:+$fw }$tool"
        fi
    done
    os=""
    if [ -f /etc/os-release ]; then
        os=$(sed -n 's/^ID=//p' /etc/os-release | tr -d "\"'")
    fi
    printf '{"machine":"%s","os_arch":"%s","pkg":"%s","os":"%s","fw":"%s"}\n' \
        "$(json_escape "$machine")" "$(json_escape "$os_arch")" "$(json_escape "$pkg")" \
        "$(json_escape "$os")" "$(json_escape "$fw")"
}

case "$1" in
    request) shift; cmd_request "$@" ;;
    context) shift; cmd_context "$@" ;;
    detect) shift; cmd_detect "$@" ;;
    *) echo "Usage: $0 request <topic> <state_dir> | context <file> | detect" >&2 ;;
esac
exit 0
