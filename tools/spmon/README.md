# spmon — Sparkplug B / thin-edge.io MQTT monitor

A terminal UI for watching and auto-decoding MQTT messages from both Sparkplug B
and thin-edge.io topics simultaneously.

```
┌ spmon  ● Connected  localhost:1883  42 msgs ────────────────────────────────┐
│ Messages [follow]      │ spBv1.0/tedge/DDATA/gateway01/sensor01             │
│ ● 12:34:01.123 te/dev… │ ─────────────────────────────────────────────────  │
│ ◆ 12:34:01.120 spBv1…  │ Timestamp:  2024-01-15T12:34:01.120Z               │
│ ● 12:33:59.001 te/dev… │ Seq:        3                                      │
│                        │                                                    │
│                        │ ─────────────────────────────────────────────────  │
│                        │ Name                     Type        Value         │
│                        │ ─────────────────────────────────────────────────  │
│                        │ temperature              Double      23.5          │
│                        │ humidity                 Double      60.0          │
└────────────────────────┴────────────────────────────────────────────────────┘
  ↑/↓  select    PgUp/PgDn  scroll    g/G  top/bottom    c  clear    R  rebirth    q  quit
```

## Build

```sh
cd tools/spmon
go build -o spmon .
```

## Usage

```sh
# Connect to local broker (default)
./spmon

# Custom broker
./spmon --broker 192.168.1.10:1883

# Sparkplug B group / edge node (must match your flow.toml config)
./spmon --group tedge --node gateway01

# Extra topics
./spmon --topics "my/custom/topic,another/topic"
```

## Keybindings

| Key       | Action                                                        |
| --------- | ------------------------------------------------------------- |
| `↑` / `↓` | Select message                                                |
| `j` / `k` | Select message (vim-style)                                    |
| `g` / `G` | Jump to first / last message                                  |
| `PgUp/Dn` | Scroll detail pane                                            |
| `c`       | Clear message list                                            |
| `R`       | Send Sparkplug B NCMD `Node Control/Rebirth` to the edge node |
| `q`       | Quit                                                          |

### Sparkplug B rebirth (`R`)

Pressing `R` sends a Sparkplug B NCMD payload with `Node Control/Rebirth = true`.

The group ID and edge node ID are **auto-detected** from the currently selected
(or nearest earlier) Sparkplug B message in the list — no manual configuration
needed once messages are flowing. The `--group` and `--node` flags act as
fallbacks when no Sparkplug B message has been received yet.

The rebirth command is published to `spBv1.0/{group}/NCMD/{node}`, which
triggers the `sparkplug-publisher` flow to re-issue retained BIRTH messages for
every known device with their current last-known metric values.

## Default subscriptions

| Topic pattern       | Decoded as             |
| ------------------- | ---------------------- |
| `spBv1.0/#`         | Sparkplug B (orange ◆) |
| `te/device/+///m/`  | thin-edge.io (teal ●)  |
| `te/device/+///m/+` | thin-edge.io (teal ●)  |

## Round-trip testing

With both `sparkplug-publisher` and `sparkplug-telemetry` flows installed:

```sh
# Terminal 1 — start monitor
./tools/spmon/spmon

# Terminal 2 — publish a JSON measurement on thin-edge.io
tedge mqtt pub te/device/sensor01///m/raw '{"temperature": 23.5, "humidity": 60}'
```

You should see two messages appear in spmon:

- **◆ orange** — `spBv1.0/tedge/DDATA/gateway01/sensor01` (encoded by sparkplug-publisher)
- **● teal** — `te/device/sensor01///m/` (decoded back by sparkplug-telemetry)

## Keys

| Key               | Action                                     |
| ----------------- | ------------------------------------------ |
| `↑` / `k`         | Select previous message                    |
| `↓` / `j`         | Select next message                        |
| `g`               | Jump to first message                      |
| `G`               | Jump to latest message (re-enables follow) |
| `PgUp` / `ctrl+b` | Scroll detail pane up                      |
| `PgDn` / `ctrl+f` | Scroll detail pane down                    |
| `c`               | Clear all messages                         |
| `q` / `ctrl+c`    | Quit                                       |
