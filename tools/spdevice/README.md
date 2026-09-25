# spdevice — Sparkplug B CNC machine simulator

A realistic Sparkplug B edge node simulator that models a CNC machining centre.
Publishes NBIRTH / NDATA / NDEATH to any MQTT broker and responds to NCMD
rebirth commands from host applications or [spmon](../spmon).

```
spdevice  ● Connected  localhost:1883  group:tedge  node:sim-cnc01  seq:14  pub:3
┌─ Machine State: RUNNING  [32s]  prog: O1001_ROUGH ─────────────┐ ┌─ Event Log ───────────────┐
│                                                                │ │ 10:14:21 ● program_start  │
│ Spindle                                                        │ │   Starting O1001_ROUGH    │
│   speed.rpm       7,843.0 rpm  ████████░░                      │ │ 10:14:08 ● door_close     │
│   load.pct           63.2 %   ███████░░░                       │ │ 10:14:06 ● door_open      │
│   temp.celsius       68.4 °C  ████░░░░░░                       │ │ 10:14:04 ● program_end    │
│                                                                │ │   O3003_PROFILE — parts:4 │
│ Feed & Motion                                                  │ │ 10:13:52 ◈ HighSpindleTemp│
│   feed.rate        782.0 mm/min                                │ │           RAISED          │
│   axis.x.pos       103.4 mm                                    │ │ 10:12:19 ◇ HighSpindleTemp│
│   axis.y.pos        55.0 mm                                    │ │           cleared         │
│   axis.z.pos        12.9 mm                                    │ │ 10:11:44 ● tool_change    │
│                                                                │ │   Tool change → T07       │
│ Coolant                                                        │ └──────────────────────────-┘
│   temp.celsius       26.1 °C
│   flow.lpm            8.2 L/min  ██████░░░░
│
│ Hydraulics
│   pressure.bar      142.7 bar  █████░░░░░
│
│ Power
│   power.kw            3.74 kW
│
│ Counters
│   cycle.count            4
│   part.count             4
│
│ I/O
│   door.open          false
│   estop.active       false
│
│ Alarms
│   HighSpindleTemp    false
│   LowCoolantFlow     false
│   HighHydraulicPressure false
│   EStop              false
└─────────────────────────────────────────────────────────────────┘
  interval:5s  next: 2.1s  p pause    r rebirth    q quit
```

## Build

```sh
cd tools/spdevice
go build -o spdevice .
```

## Usage

```sh
# Connect to local broker with defaults (group=tedge, node=sim-cnc01, interval=5s)
./spdevice

# Custom broker and faster publishing
./spdevice --broker 192.168.1.10:1883 --interval 1s

# Different group / node ID (must match your flow.toml or host application config)
./spdevice --group factory1 --node cnc-line-a --interval 2s
```

## Flags

| Flag         | Default          | Description                                        |
| ------------ | ---------------- | -------------------------------------------------- |
| `--broker`   | `localhost:1883` | MQTT broker `host:port`                            |
| `--group`    | `tedge`          | Sparkplug B Group ID                               |
| `--node`     | `sim-cnc01`      | Sparkplug B Edge Node ID                           |
| `--interval` | `5s`             | Minimum publish interval — use `1s`, `500ms`, etc. |

## Keybindings

| Key | Action                                                        |
| --- | ------------------------------------------------------------- |
| `p` | Pause / resume simulation and publishing                      |
| `r` | Send NBIRTH immediately (re-declare all metrics with aliases) |
| `q` | Publish NDEATH then quit                                      |

## Simulated metrics

| Metric                        | Type    | Range          | Alarm threshold   |
| ----------------------------- | ------- | -------------- | ----------------- |
| `spindle.speed.rpm`           | Double  | 0 – 12 000 rpm |                   |
| `spindle.load.pct`            | Double  | 0 – 100 %      | warn > 90 %       |
| `spindle.temperature.celsius` | Double  | 20 – 90 °C     | alarm > 83 °C     |
| `feed.rate.mm_per_min`        | Double  | 0 – 1 000      |                   |
| `axis.{x,y,z}.position.mm`    | Double  | 0 – 500 mm     |                   |
| `coolant.temperature.celsius` | Double  | 20 – 35 °C     | warn > 34 °C      |
| `coolant.flow.litres_per_min` | Double  | 0 – 12 L/min   | alarm < 2.0 L/min |
| `hydraulic.pressure.bar`      | Double  | 130 – 165 bar  | alarm > 157 bar   |
| `power.kw`                    | Double  | 0 – 8 kW       |                   |
| `program.cycle_count`         | Int64   | incrementing   |                   |
| `program.part_count`          | Int64   | incrementing   |                   |
| `door.open`                   | Boolean |                |                   |
| `estop.active`                | Boolean |                |                   |
| `Alarm/*/Active`              | Boolean | true / false   |                   |
| `Alarm/*/Text`                | String  |                |                   |

## Machine states

```
IDLE → WARMUP → RUNNING → COOLDOWN → IDLE
         ↕ any state → FAULT → IDLE
```

**IDLE**: Spindle stopped, axes parked, low power draw.  
**WARMUP**: Spindle ramping up slowly, coolant flow increasing.  
**RUNNING**: Full machining — spindle at target speed, axes executing path, all coolant and hydraulics active.  
**COOLDOWN**: Spindle decelerating, door briefly opens for part removal, tool change on next cycle start.  
**FAULT**: E-stop triggered (rare random event or thermal runaway), all motion stops.

## End-to-end test

```sh
# Terminal 1 – watch Sparkplug B output
cd tools/spmon && ./spmon --group tedge --node sim-cnc01

# Terminal 2 – run the device simulator
cd tools/spdevice && ./spdevice --interval 2s
```

Press `R` in spmon to send an NCMD rebirth command — spdevice will respond with
a fresh NBIRTH containing all current metric values and aliases.
