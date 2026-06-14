package main

// device.go — CNC machining centre simulation.
//
// The simulated machine cycles through:
//
//	IDLE → WARMUP → RUNNING → COOLDOWN → IDLE
//	          ↕ (any state → FAULT → IDLE)
//
// Sensor values follow basic physics:
//   - Spindle temperature has thermal mass (slow rise/fall).
//   - Spindle speed ramps at a configurable rate (acceleration limit).
//   - Coolant temperature tracks spindle load with a long lag.
//   - All values add Gaussian-like noise on every tick.
//
// Alarms use hysteresis: they raise at a high threshold and clear at a lower one.

import (
	"fmt"
	"math"
	"math/rand"
	"time"
)

// ── State machine ─────────────────────────────────────────────────────────────

type MachineState int

const (
	StateIdle     MachineState = iota
	StateWarmup   MachineState = iota
	StateRunning  MachineState = iota
	StateCooldown MachineState = iota
	StateFault    MachineState = iota
)

func (s MachineState) String() string {
	switch s {
	case StateIdle:
		return "IDLE"
	case StateWarmup:
		return "WARMUP"
	case StateRunning:
		return "RUNNING"
	case StateCooldown:
		return "COOLDOWN"
	case StateFault:
		return "FAULT"
	default:
		return "UNKNOWN"
	}
}

// ── Alarm with hysteresis ─────────────────────────────────────────────────────

type AlarmState struct {
	Active  bool
	Changed bool // true if Active changed this tick
	Text    string
}

// ── Log entry ─────────────────────────────────────────────────────────────────

type LogEntry struct {
	Time    time.Time
	Kind    string // "event" or "alarm"
	Name    string
	Active  bool // alarms only: true=raised, false=cleared
	Message string
}

// ── Device state ──────────────────────────────────────────────────────────────

type DeviceState struct {
	// Operating
	State        MachineState
	StateEntered time.Time

	// Spindle
	SpindleSpeedRPM  float64
	SpindleLoadPct   float64
	SpindleTempC     float64
	spindleTargetRPM float64
	spindleRampRate  float64

	// Feed
	FeedRateMMPerMin float64

	// Coolant
	CoolantTempC   float64
	CoolantFlowLPM float64

	// Hydraulics
	HydraulicPressBar float64

	// Power
	PowerKW float64

	// Axes (mm)
	AxisXPosMM float64
	AxisYPosMM float64
	AxisZPosMM float64
	targetX    float64
	targetY    float64
	targetZ    float64

	// Production counters
	CycleCount int64
	PartCount  int64

	// Digital I/O
	DoorOpen    bool
	EStopActive bool

	// Current program
	ProgramName string

	// Alarms
	AlarmHighSpindleTemp       AlarmState
	AlarmLowCoolantFlow        AlarmState
	AlarmHighHydraulicPressure AlarmState
	AlarmEStop                 AlarmState

	// Internal
	stateTimer float64 // seconds until next state transition
	rng        *rand.Rand
}

var programNames = []string{
	"O1001_ROUGH", "O1002_FINISH", "O1003_BORE",
	"O2001_DRILL", "O2002_TAP_M8", "O2003_REAM",
	"O3001_CONTOUR", "O3002_POCKET", "O3003_PROFILE",
	"PART_A_CYCLE1", "PART_B_CYCLE2", "JIG_BORE_3",
}

// NewDeviceState creates a fresh device ready to simulate.
func NewDeviceState() *DeviceState {
	rng := rand.New(rand.NewSource(time.Now().UnixNano()))
	d := &DeviceState{
		State:             StateIdle,
		StateEntered:      time.Now(),
		SpindleTempC:      20.0 + rng.Float64()*3,
		CoolantTempC:      20.0 + rng.Float64()*2,
		HydraulicPressBar: 138.0 + rng.Float64()*4,
		PowerKW:           0.4,
		ProgramName:       programNames[rng.Intn(len(programNames))],
		stateTimer:        3 + rng.Float64()*10, // short initial idle
		rng:               rng,
	}
	d.targetX = rng.Float64() * 500
	d.targetY = rng.Float64() * 300
	d.targetZ = rng.Float64() * 200
	return d
}

// ── Tick ──────────────────────────────────────────────────────────────────────

// Tick advances the simulation by dt seconds and returns any events/alarms that fired.
func (d *DeviceState) Tick(dt float64) []LogEntry {
	var logs []LogEntry

	d.stateTimer -= dt

	// ── State transitions ────────────────────────────────────────────────────
	switch d.State {

	case StateIdle:
		if d.stateTimer <= 0 {
			d.enterWarmup()
			logs = append(logs, LogEntry{
				Time:    time.Now(),
				Kind:    "event",
				Name:    "program_start",
				Message: fmt.Sprintf("Starting %s", d.ProgramName),
			})
		}

	case StateWarmup:
		if d.stateTimer <= 0 {
			d.enterRunning()
		}

	case StateRunning:
		// Randomly vary spindle speed within machining range
		if d.rng.Float64() < dt*0.08 {
			d.spindleTargetRPM = 2000 + d.rng.Float64()*10000
		}
		// Randomly re-target axes
		if d.rng.Float64() < dt*0.15 {
			d.targetX = d.rng.Float64() * 500
			d.targetY = d.rng.Float64() * 300
			d.targetZ = d.rng.Float64() * 200
		}
		if d.stateTimer <= 0 {
			d.CycleCount++
			d.PartCount++
			d.enterCooldown()
			// Door opens briefly between cycles
			d.DoorOpen = true
			logs = append(logs, LogEntry{
				Time:    time.Now(),
				Kind:    "event",
				Name:    "program_end",
				Message: fmt.Sprintf("%s complete — parts: %d", d.ProgramName, d.PartCount),
			})
			logs = append(logs, LogEntry{
				Time:    time.Now(),
				Kind:    "event",
				Name:    "door_open",
				Message: "Safety door opened for part removal",
			})
		}

	case StateCooldown:
		if d.stateTimer <= 0 {
			d.DoorOpen = false
			d.ProgramName = programNames[d.rng.Intn(len(programNames))]
			logs = append(logs, LogEntry{
				Time:    time.Now(),
				Kind:    "event",
				Name:    "door_close",
				Message: "Safety door closed",
			})
			if d.rng.Float64() < 0.7 {
				tool := 1 + d.rng.Intn(24)
				logs = append(logs, LogEntry{
					Time:    time.Now(),
					Kind:    "event",
					Name:    "tool_change",
					Message: fmt.Sprintf("Tool change → T%02d", tool),
				})
			}
			d.enterIdle()
		}

	case StateFault:
		if d.stateTimer <= 0 {
			d.EStopActive = false
			d.enterIdle()
			logs = append(logs, LogEntry{
				Time:    time.Now(),
				Kind:    "event",
				Name:    "estop_reset",
				Message: "E-Stop cleared — resuming operation",
			})
		}
	}

	// ── Occasional random fault (any non-fault state) ────────────────────────
	// Probability ≈ 0.02% per second ≈ one fault every ~80 minutes.
	if d.State != StateFault && d.rng.Float64() < dt*0.0002 {
		faultCode := d.rng.Intn(100)
		d.EStopActive = true
		d.spindleTargetRPM = 0
		d.spindleRampRate = 600
		d.State = StateFault
		d.StateEntered = time.Now()
		d.stateTimer = 12 + d.rng.Float64()*25
		logs = append(logs, LogEntry{
			Time:    time.Now(),
			Kind:    "event",
			Name:    "estop_triggered",
			Message: fmt.Sprintf("E-Stop triggered — fault code F%03d", faultCode),
		})
	}

	// ── Physics ──────────────────────────────────────────────────────────────
	d.updateSensors(dt)

	// ── Alarm evaluation ─────────────────────────────────────────────────────
	logs = append(logs, d.evaluateAlarms()...)

	return logs
}

func (d *DeviceState) enterWarmup() {
	d.State = StateWarmup
	d.StateEntered = time.Now()
	d.stateTimer = 6 + d.rng.Float64()*12
	d.spindleTargetRPM = 400 + d.rng.Float64()*1200
	d.spindleRampRate = 150 + d.rng.Float64()*80
}

func (d *DeviceState) enterRunning() {
	d.State = StateRunning
	d.StateEntered = time.Now()
	d.stateTimer = 25 + d.rng.Float64()*110
	d.spindleTargetRPM = 2500 + d.rng.Float64()*9500
	d.spindleRampRate = 400 + d.rng.Float64()*400
}

func (d *DeviceState) enterCooldown() {
	d.State = StateCooldown
	d.StateEntered = time.Now()
	d.stateTimer = 6 + d.rng.Float64()*12
	d.spindleTargetRPM = 0
	d.spindleRampRate = 300
}

func (d *DeviceState) enterIdle() {
	d.State = StateIdle
	d.StateEntered = time.Now()
	d.stateTimer = 8 + d.rng.Float64()*20
}

// ── Sensor physics ────────────────────────────────────────────────────────────

func (d *DeviceState) updateSensors(dt float64) {
	switch d.State {

	case StateIdle:
		d.FeedRateMMPerMin = 0
		d.CoolantFlowLPM = converge(d.CoolantFlowLPM, 0, dt*3)
		d.HydraulicPressBar = converge(d.HydraulicPressBar, 139+d.noise(6), dt*0.15)
		d.PowerKW = converge(d.PowerKW, 0.40+d.noise(0.05), dt*0.4)
		d.AxisXPosMM = converge(d.AxisXPosMM, 0, dt*15)
		d.AxisYPosMM = converge(d.AxisYPosMM, 0, dt*15)
		d.AxisZPosMM = converge(d.AxisZPosMM, 0, dt*15)

	case StateWarmup:
		d.FeedRateMMPerMin = 0
		d.CoolantFlowLPM = converge(d.CoolantFlowLPM, 2.5+d.noise(0.4), dt*0.8)
		d.HydraulicPressBar = converge(d.HydraulicPressBar, 143+d.noise(4), dt*0.25)
		d.PowerKW = converge(d.PowerKW, 1.1+d.noise(0.15), dt*0.3)

	case StateRunning:
		frac := d.SpindleSpeedRPM / 12000.0
		d.FeedRateMMPerMin = math.Max(0, 200+frac*780+d.noise(25))
		d.CoolantFlowLPM = converge(d.CoolantFlowLPM, 5+frac*6+d.noise(0.6), dt*1.2)
		d.HydraulicPressBar = converge(d.HydraulicPressBar, 141+frac*18+d.noise(4), dt*0.4)
		d.PowerKW = converge(d.PowerKW, 1.4+frac*6.5+d.noise(0.4), dt*0.5)
		d.AxisXPosMM = converge(d.AxisXPosMM, d.targetX, dt*60+d.noise(3))
		d.AxisYPosMM = converge(d.AxisYPosMM, d.targetY, dt*50+d.noise(3))
		d.AxisZPosMM = converge(d.AxisZPosMM, d.targetZ, dt*40+d.noise(2))

	case StateCooldown, StateFault:
		d.FeedRateMMPerMin = 0
		d.CoolantFlowLPM = converge(d.CoolantFlowLPM, 1.8+d.noise(0.3), dt*0.5)
		d.HydraulicPressBar = converge(d.HydraulicPressBar, 138+d.noise(3), dt*0.15)
		d.PowerKW = converge(d.PowerKW, 0.55+d.noise(0.08), dt*0.3)
	}

	// Spindle speed ramps toward target (acceleration-limited)
	diff := d.spindleTargetRPM - d.SpindleSpeedRPM
	if math.Abs(diff) <= d.spindleRampRate*dt {
		d.SpindleSpeedRPM = d.spindleTargetRPM
	} else if diff > 0 {
		d.SpindleSpeedRPM += d.spindleRampRate * dt
	} else {
		d.SpindleSpeedRPM -= d.spindleRampRate * dt
	}

	// Spindle load: tracks speed with lag and noise
	targetLoad := 0.0
	if d.SpindleSpeedRPM > 50 {
		targetLoad = 12 + (d.SpindleSpeedRPM/12000.0)*72 + d.noise(6)
	}
	d.SpindleLoadPct = clamp(converge(d.SpindleLoadPct, targetLoad, dt*8), 0, 100)

	// Spindle temperature: thermal mass (~5 min time constant)
	ambient := 21.0
	targetTemp := ambient
	switch d.State {
	case StateRunning:
		targetTemp = ambient + (d.SpindleLoadPct/100.0)*67
	case StateWarmup:
		targetTemp = ambient + (d.SpindleSpeedRPM/12000.0)*28
	case StateCooldown:
		targetTemp = ambient + (d.SpindleTempC-ambient)*0.6
	}
	d.SpindleTempC = converge(d.SpindleTempC, targetTemp+d.noise(0.3), dt*0.25)

	// Coolant temperature: lags behind spindle load with a longer time constant
	targetCoolant := ambient + (d.SpindleTempC-ambient)*0.12 + d.noise(0.25)
	d.CoolantTempC = converge(d.CoolantTempC, targetCoolant, dt*0.06)

	// Physical bounds
	d.SpindleSpeedRPM = clamp(d.SpindleSpeedRPM, 0, 15000)
	d.SpindleTempC = clamp(d.SpindleTempC, ambient, 120)
	d.CoolantFlowLPM = clamp(d.CoolantFlowLPM, 0, 15)
	d.HydraulicPressBar = clamp(d.HydraulicPressBar, 100, 200)
	d.PowerKW = clamp(d.PowerKW, 0, 12)
	d.AxisXPosMM = clamp(d.AxisXPosMM, 0, 500)
	d.AxisYPosMM = clamp(d.AxisYPosMM, 0, 300)
	d.AxisZPosMM = clamp(d.AxisZPosMM, 0, 200)
}

// ── Alarm evaluation ──────────────────────────────────────────────────────────

func (d *DeviceState) evaluateAlarms() []LogEntry {
	var logs []LogEntry

	// HighSpindleTemp: raise >83°C, clear <78°C
	logs = append(logs, d.checkAlarm(
		&d.AlarmHighSpindleTemp, "HighSpindleTemp",
		d.SpindleTempC > 83, d.SpindleTempC < 78,
		fmt.Sprintf("Spindle temperature %.1f°C exceeds limit (83°C)", d.SpindleTempC),
	)...)

	// LowCoolantFlow: raise when RUNNING and < 2.0, clear > 3.2
	lowFlow := d.State == StateRunning && d.CoolantFlowLPM < 2.0
	clearFlow := d.CoolantFlowLPM > 3.2 || d.State != StateRunning
	logs = append(logs, d.checkAlarm(
		&d.AlarmLowCoolantFlow, "LowCoolantFlow",
		lowFlow, clearFlow,
		fmt.Sprintf("Coolant flow %.2f L/min below minimum (2.0)", d.CoolantFlowLPM),
	)...)

	// HighHydraulicPressure: raise >157 bar, clear <153
	logs = append(logs, d.checkAlarm(
		&d.AlarmHighHydraulicPressure, "HighHydraulicPressure",
		d.HydraulicPressBar > 157, d.HydraulicPressBar < 153,
		fmt.Sprintf("Hydraulic pressure %.1f bar exceeds limit (157 bar)", d.HydraulicPressBar),
	)...)

	// EStop
	logs = append(logs, d.checkAlarm(
		&d.AlarmEStop, "EStop",
		d.EStopActive, !d.EStopActive,
		"Emergency stop active",
	)...)

	return logs
}

func (d *DeviceState) checkAlarm(a *AlarmState, name string, raise, clear bool, text string) []LogEntry {
	a.Changed = false
	if !a.Active && raise {
		a.Active = true
		a.Changed = true
		a.Text = text
		return []LogEntry{{Time: time.Now(), Kind: "alarm", Name: name, Active: true, Message: text}}
	}
	if a.Active && clear {
		a.Active = false
		a.Changed = true
		a.Text = ""
		return []LogEntry{{Time: time.Now(), Kind: "alarm", Name: name, Active: false, Message: "cleared"}}
	}
	return nil
}

// ── Metric definitions ────────────────────────────────────────────────────────
// Each entry defines a Sparkplug B metric with a static alias, its datatype,
// and how to extract the current value from DeviceState. The section & display
// fields drive the TUI layout.

type MetricDef struct {
	Name     string
	Alias    uint64
	DataType uint32
	Value    func(*DeviceState) interface{}
	Section  string  // display grouping
	Label    string  // short label for TUI
	Unit     string  // unit suffix for display
	WarnHigh float64 // > 0: show warning indicator when value exceeds this
	WarnLow  float64 // > 0: show warning indicator when value is below this
}

// MetricDefs is the canonical ordered list of all metrics.
// Alias 0 is reserved for bdSeq; aliases start at 1.
var MetricDefs = []MetricDef{
	// ── Spindle ──────────────────────────────────────────────────────────────
	{
		Name: "spindle.speed.rpm", Alias: 1, DataType: spTypeDouble,
		Value:   func(d *DeviceState) interface{} { return d.SpindleSpeedRPM },
		Section: "Spindle", Label: "speed.rpm", Unit: "rpm",
	},
	{
		Name: "spindle.load.pct", Alias: 2, DataType: spTypeDouble,
		Value:   func(d *DeviceState) interface{} { return d.SpindleLoadPct },
		Section: "Spindle", Label: "load.pct", Unit: "%",
		WarnHigh: 90,
	},
	{
		Name: "spindle.temperature.celsius", Alias: 3, DataType: spTypeDouble,
		Value:   func(d *DeviceState) interface{} { return d.SpindleTempC },
		Section: "Spindle", Label: "temp.celsius", Unit: "°C",
		WarnHigh: 80,
	},
	// ── Feed & Motion ────────────────────────────────────────────────────────
	{
		Name: "feed.rate.mm_per_min", Alias: 4, DataType: spTypeDouble,
		Value:   func(d *DeviceState) interface{} { return d.FeedRateMMPerMin },
		Section: "Feed & Motion", Label: "feed.rate", Unit: "mm/min",
	},
	{
		Name: "axis.x.position.mm", Alias: 5, DataType: spTypeDouble,
		Value:   func(d *DeviceState) interface{} { return d.AxisXPosMM },
		Section: "Feed & Motion", Label: "axis.x.pos", Unit: "mm",
	},
	{
		Name: "axis.y.position.mm", Alias: 6, DataType: spTypeDouble,
		Value:   func(d *DeviceState) interface{} { return d.AxisYPosMM },
		Section: "Feed & Motion", Label: "axis.y.pos", Unit: "mm",
	},
	{
		Name: "axis.z.position.mm", Alias: 7, DataType: spTypeDouble,
		Value:   func(d *DeviceState) interface{} { return d.AxisZPosMM },
		Section: "Feed & Motion", Label: "axis.z.pos", Unit: "mm",
	},
	// ── Coolant ──────────────────────────────────────────────────────────────
	{
		Name: "coolant.temperature.celsius", Alias: 8, DataType: spTypeDouble,
		Value:   func(d *DeviceState) interface{} { return d.CoolantTempC },
		Section: "Coolant", Label: "temp.celsius", Unit: "°C",
		WarnHigh: 34,
	},
	{
		Name: "coolant.flow.litres_per_min", Alias: 9, DataType: spTypeDouble,
		Value:   func(d *DeviceState) interface{} { return d.CoolantFlowLPM },
		Section: "Coolant", Label: "flow.lpm", Unit: "L/min",
		WarnLow: 2.0,
	},
	// ── Hydraulics ───────────────────────────────────────────────────────────
	{
		Name: "hydraulic.pressure.bar", Alias: 10, DataType: spTypeDouble,
		Value:   func(d *DeviceState) interface{} { return d.HydraulicPressBar },
		Section: "Hydraulics", Label: "pressure.bar", Unit: "bar",
		WarnHigh: 155,
	},
	// ── Power ────────────────────────────────────────────────────────────────
	{
		Name: "power.kw", Alias: 11, DataType: spTypeDouble,
		Value:   func(d *DeviceState) interface{} { return d.PowerKW },
		Section: "Power", Label: "power.kw", Unit: "kW",
	},
	// ── Production counters ──────────────────────────────────────────────────
	{
		Name: "program.cycle_count", Alias: 12, DataType: spTypeInt64,
		Value:   func(d *DeviceState) interface{} { return d.CycleCount },
		Section: "Counters", Label: "cycle.count", Unit: "",
	},
	{
		Name: "program.part_count", Alias: 13, DataType: spTypeInt64,
		Value:   func(d *DeviceState) interface{} { return d.PartCount },
		Section: "Counters", Label: "part.count", Unit: "",
	},
	// ── Digital I/O ──────────────────────────────────────────────────────────
	{
		Name: "door.open", Alias: 14, DataType: spTypeBoolean,
		Value:   func(d *DeviceState) interface{} { return d.DoorOpen },
		Section: "I/O", Label: "door.open", Unit: "",
	},
	{
		Name: "estop.active", Alias: 15, DataType: spTypeBoolean,
		Value:   func(d *DeviceState) interface{} { return d.EStopActive },
		Section: "I/O", Label: "estop.active", Unit: "",
	},
	// ── Alarms ───────────────────────────────────────────────────────────────
	{
		Name: "Alarm/HighSpindleTemp/Active", Alias: 16, DataType: spTypeBoolean,
		Value:   func(d *DeviceState) interface{} { return d.AlarmHighSpindleTemp.Active },
		Section: "Alarms", Label: "HighSpindleTemp", Unit: "",
	},
	{
		Name: "Alarm/HighSpindleTemp/Text", Alias: 17, DataType: spTypeString,
		Value:   func(d *DeviceState) interface{} { return d.AlarmHighSpindleTemp.Text },
		Section: "", Label: "", // skip in TUI; shown via event log
	},
	{
		Name: "Alarm/LowCoolantFlow/Active", Alias: 18, DataType: spTypeBoolean,
		Value:   func(d *DeviceState) interface{} { return d.AlarmLowCoolantFlow.Active },
		Section: "Alarms", Label: "LowCoolantFlow", Unit: "",
	},
	{
		Name: "Alarm/LowCoolantFlow/Text", Alias: 19, DataType: spTypeString,
		Value:   func(d *DeviceState) interface{} { return d.AlarmLowCoolantFlow.Text },
		Section: "", Label: "",
	},
	{
		Name: "Alarm/HighHydraulicPressure/Active", Alias: 20, DataType: spTypeBoolean,
		Value:   func(d *DeviceState) interface{} { return d.AlarmHighHydraulicPressure.Active },
		Section: "Alarms", Label: "HighHydraulicPressure", Unit: "",
	},
	{
		Name: "Alarm/HighHydraulicPressure/Text", Alias: 21, DataType: spTypeString,
		Value:   func(d *DeviceState) interface{} { return d.AlarmHighHydraulicPressure.Text },
		Section: "", Label: "",
	},
	{
		Name: "Alarm/EStop/Active", Alias: 22, DataType: spTypeBoolean,
		Value:   func(d *DeviceState) interface{} { return d.AlarmEStop.Active },
		Section: "Alarms", Label: "EStop", Unit: "",
	},
	{
		Name: "Alarm/EStop/Text", Alias: 23, DataType: spTypeString,
		Value:   func(d *DeviceState) interface{} { return d.AlarmEStop.Text },
		Section: "", Label: "",
	},
}

// ── Physics helpers ───────────────────────────────────────────────────────────

// converge moves current toward target at the given rate per second, clamped.
func converge(current, target, ratePerSec float64) float64 {
	diff := target - current
	if math.Abs(diff) <= ratePerSec {
		return target
	}
	if diff > 0 {
		return current + ratePerSec
	}
	return current - ratePerSec
}

func clamp(v, lo, hi float64) float64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// noise returns a value uniformly distributed in [-amplitude, +amplitude].
func (d *DeviceState) noise(amplitude float64) float64 {
	return (d.rng.Float64()*2 - 1) * amplitude
}
