package main

// main.go — CNC device simulator TUI.
//
// Two publish modes selected with --mode:
//
//   sparkplug (default)
//     Connects as a Sparkplug B edge node, publishes NBIRTH / NDATA / NDEATH
//     directly to spBv1.0/{group}/{cmd}/{node}.  Use this to test a Sparkplug B
//     broker or the spmon monitor without the sparkplug-publisher flow.
//
//   tedge
//     Publishes thin-edge.io format so the sparkplug-publisher flow translates
//     it into Sparkplug B:
//       te/device/{node}///m/raw   — measurements (JSON object, periodic)
//       te/device/{node}///e/{name} — events (JSON {"text":…}, on occurrence)
//       te/device/{node}///a/{name} — alarms (JSON {"text":…} retained; empty to clear)
//
// Usage:
//
//	./spdevice --broker localhost:1883 --group tedge --node sim-cnc01 --mode sparkplug
//	./spdevice --broker localhost:1883 --node sim-cnc01 --mode tedge
//
// Press p to pause, r to re-publish birth/measurements, q to quit.

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"math"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	mqtt "github.com/eclipse/paho.mqtt.golang"
)

// ── Constants ─────────────────────────────────────────────────────────────────

const maxLogEntries = 150

// ── MQTT message types for Bubbletea ─────────────────────────────────────────

type tickMsg time.Time
type connStatusMsg bool
type rebirthCmdMsg struct{}

// ── Styles ────────────────────────────────────────────────────────────────────

var (
	colorTeal    = lipgloss.Color("#00d7af")
	colorOrange  = lipgloss.Color("#ff8700")
	colorRed     = lipgloss.Color("#ff5f5f")
	colorGreen   = lipgloss.Color("#87ff00")
	colorYellow  = lipgloss.Color("#ffd700")
	colorBorder  = lipgloss.Color("#444444")
	colorDim     = lipgloss.Color("#888888")
	colorRunning = lipgloss.Color("#00d7af")
	colorFault   = lipgloss.Color("#ff5f5f")
	colorWarmup  = lipgloss.Color("#ffd700")
	colorIdle    = lipgloss.Color("#888888")

	styleHeader  = lipgloss.NewStyle().Bold(true).Foreground(colorTeal)
	styleDim     = lipgloss.NewStyle().Foreground(colorDim)
	styleWarn    = lipgloss.NewStyle().Foreground(colorYellow)
	styleCrit    = lipgloss.NewStyle().Foreground(colorRed)
	styleGood    = lipgloss.NewStyle().Foreground(colorGreen)
	styleSection = lipgloss.NewStyle().Bold(true).Foreground(colorOrange)
	styleHelp    = lipgloss.NewStyle().Foreground(colorDim)
	styleAlarm   = lipgloss.NewStyle().Foreground(colorRed)
	styleEvent   = lipgloss.NewStyle().Foreground(colorTeal)
	stylePaused  = lipgloss.NewStyle().Foreground(colorYellow).Bold(true)
)

// ── Model ─────────────────────────────────────────────────────────────────────

type Model struct {
	// Simulation
	device     *DeviceState
	logEntries []LogEntry

	// Config
	broker     string
	mode       string // "sparkplug" or "tedge"
	groupId    string
	edgeNodeId string
	interval   time.Duration

	// Publish state (must be accessed with mu held except in Bubbletea Update)
	mu        sync.Mutex
	pubCount  int
	seq       uint64
	bdSeq     uint64
	connected bool
	paused    bool

	// Timing
	lastTick    time.Time
	nextPublish time.Time

	// MQTT
	mqttClient mqtt.Client
	connCh     chan bool
	rebirthCh  chan struct{}

	// TUI
	width        int
	height       int
	logVP        viewport.Model
	logVPReady   bool
	logNeedsSync atomic.Bool
}

func newModel(broker, mode, groupId, edgeNodeId string, interval time.Duration) *Model {
	m := &Model{
		device:      NewDeviceState(),
		broker:      broker,
		mode:        mode,
		groupId:     groupId,
		edgeNodeId:  edgeNodeId,
		interval:    interval,
		lastTick:    time.Now(),
		nextPublish: time.Now().Add(2 * time.Second), // short warm-up delay
		connCh:      make(chan bool, 4),
		rebirthCh:   make(chan struct{}, 4),
	}
	return m
}

// ── Bubbletea Init / Update / View ────────────────────────────────────────────

func (m *Model) Init() tea.Cmd {
	return tea.Batch(
		tea.SetWindowTitle("spdevice — Sparkplug B CNC Simulator"),
		tickEvery(200*time.Millisecond),
		waitForConn(m.connCh),
		waitForRebirth(m.rebirthCh),
	)
}

func tickEvery(d time.Duration) tea.Cmd {
	return tea.Tick(d, func(t time.Time) tea.Msg { return tickMsg(t) })
}

func waitForConn(ch <-chan bool) tea.Cmd {
	return func() tea.Msg { return connStatusMsg(<-ch) }
}

func waitForRebirth(ch <-chan struct{}) tea.Cmd {
	return func() tea.Msg { <-ch; return rebirthCmdMsg{} }
}

func (m *Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	var cmds []tea.Cmd

	switch msg := msg.(type) {

	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		m.resizeLogVP()

	case connStatusMsg:
		m.mu.Lock()
		m.connected = bool(msg)
		m.mu.Unlock()
		if bool(msg) {
			go m.publishBirth()
		}
		cmds = append(cmds, waitForConn(m.connCh))

	case rebirthCmdMsg:
		go m.publishBirth()
		cmds = append(cmds, waitForRebirth(m.rebirthCh))

	case tickMsg:
		now := time.Time(msg)
		dt := now.Sub(m.lastTick).Seconds()
		if dt > 0.5 {
			dt = 0.5 // cap at 500ms to avoid big jumps after pause
		}
		m.lastTick = now

		m.mu.Lock()
		paused := m.paused
		m.mu.Unlock()

		if !paused {
			logs := m.device.Tick(dt)
			if len(logs) > 0 {
				m.logEntries = append(logs, m.logEntries...)
				if len(m.logEntries) > maxLogEntries {
					m.logEntries = m.logEntries[:maxLogEntries]
				}
				m.logNeedsSync.Store(true)
			}

			m.mu.Lock()
			conn := m.connected
			due := now.After(m.nextPublish)
			m.mu.Unlock()

			if conn {
				// In thin-edge.io mode publish events and alarms as they occur.
				if m.mode == "tedge" && len(logs) > 0 {
					go m.publishTeEvents(logs)
				}
				if due {
					go m.publishData()
					m.mu.Lock()
					m.nextPublish = now.Add(m.interval)
					m.mu.Unlock()
				}
			}
		}

		// Sync log viewport if content changed
		if m.logVPReady && m.logNeedsSync.CompareAndSwap(true, false) {
			m.logVP.SetContent(m.renderLogContent())
			m.logVP.GotoTop()
		}

		cmds = append(cmds, tickEvery(200*time.Millisecond))

	case tea.KeyMsg:
		switch msg.String() {
		case "q", "ctrl+c":
			if m.mqttClient != nil {
				go func() {
					m.publishDeath()
					m.mqttClient.Disconnect(500)
				}()
			}
			return m, tea.Quit

		case "p", " ":
			m.mu.Lock()
			m.paused = !m.paused
			m.mu.Unlock()

		case "r":
			m.mu.Lock()
			conn := m.connected
			m.mu.Unlock()
			if conn {
				go m.publishBirth()
			}
		}
	}

	var vpCmd tea.Cmd
	m.logVP, vpCmd = m.logVP.Update(msg)
	cmds = append(cmds, vpCmd)
	return m, tea.Batch(cmds...)
}

func (m *Model) resizeLogVP() {
	if m.width == 0 {
		return
	}
	_, logW := m.paneWidths()
	bodyH := m.bodyHeight()
	if !m.logVPReady {
		m.logVP = viewport.New(logW, bodyH)
		m.logVP.SetContent(m.renderLogContent())
		m.logVPReady = true
	} else {
		m.logVP.Width = logW
		m.logVP.Height = bodyH
	}
}

func (m Model) paneWidths() (metricsW, logW int) {
	if m.width == 0 {
		return 50, 50
	}
	metricsW = m.width * 58 / 100
	logW = m.width - metricsW - 1
	if metricsW < 30 {
		metricsW = 30
	}
	if logW < 20 {
		logW = 20
	}
	return
}

func (m Model) bodyHeight() int {
	h := m.height - 3 // header + footer
	if h < 5 {
		return 5
	}
	return h
}

// ── View ──────────────────────────────────────────────────────────────────────

func (m Model) View() string {
	if m.width == 0 {
		return "Initialising…"
	}
	metricsW, logW := m.paneWidths()
	bodyH := m.bodyHeight()

	m.mu.Lock()
	connected := m.connected
	seq := m.seq
	pubCount := m.pubCount
	paused := m.paused
	nextIn := time.Until(m.nextPublish)
	m.mu.Unlock()

	// ── Header ──────────────────────────────────────────────────────────────
	connStatus := styleDim.Render("○ Connecting…")
	if connected {
		connStatus = styleHeader.Render("● Connected") + styleDim.Render("  "+m.broker)
	}
	header := lipgloss.PlaceHorizontal(m.width, lipgloss.Left,
		styleHeader.Render("spdevice")+"  "+connStatus+
			styleDim.Render(fmt.Sprintf("  group:%s  node:%s  seq:%d  pub:%d",
				m.groupId, m.edgeNodeId, seq, pubCount)))

	// ── Left pane: live metrics ──────────────────────────────────────────────
	metricsContent := m.renderMetrics(metricsW - 2)

	metricsPane := lipgloss.NewStyle().
		Border(lipgloss.NormalBorder()).
		BorderForeground(colorBorder).
		Width(metricsW).
		Height(bodyH + 1).
		Render(metricsContent)

	// ── Right pane: event / alarm log ────────────────────────────────────────
	logTitle := styleSection.Render("Event Log")
	if m.logVPReady {
		m.logVP.Width = logW - 2
		m.logVP.Height = bodyH - 1
	}
	logPane := lipgloss.NewStyle().
		Border(lipgloss.NormalBorder()).
		BorderForeground(colorBorder).
		Width(logW).
		Height(bodyH + 1).
		Render(logTitle + "\n" + m.logVP.View())

	// ── Footer ───────────────────────────────────────────────────────────────
	pauseStr := ""
	if paused {
		pauseStr = stylePaused.Render("  ⏸ PAUSED") + styleDim.Render(" ")
	}
	nextStr := ""
	if connected && !paused && nextIn > 0 {
		nextStr = styleDim.Render(fmt.Sprintf("  next: %.1fs", nextIn.Seconds()))
	}
	footer := styleHelp.Render(fmt.Sprintf(
		"  interval:%s%s  p pause    r rebirth    q quit",
		m.interval, nextStr)) + pauseStr

	body := lipgloss.JoinHorizontal(lipgloss.Top, metricsPane, logPane)
	return lipgloss.JoinVertical(lipgloss.Left, header, body, footer)
}

// ── Metrics renderer ──────────────────────────────────────────────────────────

func (m Model) renderMetrics(innerW int) string {
	d := m.device
	elapsed := time.Since(d.StateEntered).Round(time.Second)

	stateStyle := styleDim
	switch d.State {
	case StateRunning:
		stateStyle = lipgloss.NewStyle().Foreground(colorRunning).Bold(true)
	case StateFault:
		stateStyle = lipgloss.NewStyle().Foreground(colorFault).Bold(true)
	case StateWarmup, StateCooldown:
		stateStyle = lipgloss.NewStyle().Foreground(colorWarmup).Bold(true)
	}

	var b strings.Builder
	b.WriteString(styleSection.Render("Machine State: "))
	b.WriteString(stateStyle.Render(d.State.String()))
	b.WriteString(styleDim.Render(fmt.Sprintf("  [%s]  prog: %s\n", elapsed, d.ProgramName)))

	currentSection := ""
	labelW := 22
	valW := 10

	for _, def := range MetricDefs {
		if def.Section == "" || def.Label == "" {
			continue
		}
		if def.Section != currentSection {
			currentSection = def.Section
			b.WriteString("\n")
			b.WriteString(styleSection.Render(def.Section) + "\n")
		}

		val := def.Value(d)
		valStr := formatVal(val, def.Unit)

		// Determine warning state
		warn := false
		crit := false
		if def.WarnHigh > 0 {
			if fv, ok := toFloat64(val); ok {
				warn = fv > def.WarnHigh*0.93
				crit = fv > def.WarnHigh
			}
		}
		if def.WarnLow > 0 {
			if fv, ok := toFloat64(val); ok && d.State == StateRunning {
				warn = warn || fv < def.WarnLow*1.5
				crit = crit || fv < def.WarnLow
			}
		}

		// Bar for numeric values
		barStr := ""
		if fv, ok := toFloat64(val); ok && def.WarnHigh > 0 {
			barStr = "  " + renderBar(fv/def.WarnHigh, 10, crit)
		} else if fv, ok := toFloat64(val); ok && def.Unit == "rpm" {
			barStr = "  " + renderBar(fv/12000.0, 10, false)
		} else if fv, ok := toFloat64(val); ok && def.Unit == "%" {
			barStr = "  " + renderBar(fv/100.0, 10, crit)
		}

		icon := "  "
		if crit {
			icon = styleWarn.Render(" ⚠")
		} else if warn {
			icon = styleDim.Render(" ·")
		}

		labelStr := fmt.Sprintf("  %-*s", labelW, def.Label)
		valStyled := styleDim.Render(fmt.Sprintf("%*s", valW, valStr))
		if crit {
			valStyled = styleCrit.Render(fmt.Sprintf("%*s", valW, valStr))
		} else if warn {
			valStyled = styleWarn.Render(fmt.Sprintf("%*s", valW, valStr))
		}
		// Boolean values get special colouring
		if bv, ok := val.(bool); ok {
			if bv {
				valStyled = styleCrit.Render(fmt.Sprintf("%*s", valW, valStr))
			} else {
				valStyled = styleGood.Render(fmt.Sprintf("%*s", valW, valStr))
			}
		}

		line := labelStr + valStyled + barStr + icon + "\n"
		// Truncate to fit pane
		if lipgloss.Width(line) > innerW {
			line = truncate(line, innerW) + "\n"
		}
		b.WriteString(line)
	}

	return b.String()
}

func renderBar(fraction float64, width int, critical bool) string {
	filled := int(math.Round(float64(fraction) * float64(width)))
	if filled < 0 {
		filled = 0
	}
	if filled > width {
		filled = width
	}
	empty := width - filled
	bar := strings.Repeat("█", filled) + strings.Repeat("░", empty)
	if critical {
		return styleCrit.Render(bar)
	}
	return styleDim.Render(bar)
}

func (m Model) renderLogContent() string {
	var b strings.Builder
	for _, e := range m.logEntries {
		ts := styleDim.Render(e.Time.Format("15:04:05"))
		switch e.Kind {
		case "alarm":
			icon := styleAlarm.Render("◈")
			state := styleAlarm.Render("RAISED")
			if !e.Active {
				state = styleGood.Render("cleared")
				icon = styleGood.Render("◇")
			}
			b.WriteString(fmt.Sprintf("%s %s %-22s %s\n", ts, icon, e.Name, state))
			if e.Active && e.Message != "" {
				b.WriteString(styleDim.Render("         "+e.Message) + "\n")
			}
		case "event":
			icon := styleEvent.Render("●")
			b.WriteString(fmt.Sprintf("%s %s %s\n", ts, icon, styleEvent.Render(e.Name)))
			if e.Message != "" {
				b.WriteString(styleDim.Render("         "+e.Message) + "\n")
			}
		}
	}
	return b.String()
}

// ── MQTT publishing ───────────────────────────────────────────────────────────
//
// Each public method dispatches to the mode-specific implementation.

func (m *Model) publishBirth() {
	if m.mode == "tedge" {
		m.publishTeBirth()
	} else {
		m.publishSpBirth()
	}
}

func (m *Model) publishData() {
	if m.mode == "tedge" {
		m.publishTeData()
	} else {
		m.publishSpData()
	}
}

func (m *Model) publishDeath() {
	if m.mode == "tedge" {
		// thin-edge.io has no NDEATH concept; clear active alarm retains on exit.
		m.publishTeDeathClearAlarms()
	} else {
		m.publishSpDeath()
	}
}

// ── Sparkplug B publish (direct) ──────────────────────────────────────────────

func (m *Model) publishSpBirth() {
	m.mu.Lock()
	m.seq = 0
	m.mu.Unlock()

	d := m.device
	ts := time.Now()
	var metrics []SpMetric

	m.mu.Lock()
	bdSeq := m.bdSeq
	m.mu.Unlock()
	metrics = append(metrics, SpMetric{
		Name:     "bdSeq",
		Alias:    0,
		DataType: spTypeUInt64,
		Value:    bdSeq,
	})

	for _, def := range MetricDefs {
		metrics = append(metrics, SpMetric{
			Name:     def.Name,
			Alias:    def.Alias,
			DataType: def.DataType,
			Value:    def.Value(d),
		})
	}

	payload := EncodePayload(0, ts, metrics)
	topic := fmt.Sprintf("spBv1.0/%s/NBIRTH/%s", m.groupId, m.edgeNodeId)
	tok := m.mqttClient.Publish(topic, 1, true, payload)
	tok.Wait()

	m.mu.Lock()
	m.seq = 1
	m.mu.Unlock()
}

func (m *Model) publishSpData() {
	m.mu.Lock()
	seq := m.seq
	m.seq = (m.seq + 1) % 256
	m.mu.Unlock()

	d := m.device
	ts := time.Now()
	var metrics []SpMetric

	for _, def := range MetricDefs {
		metrics = append(metrics, SpMetric{
			Alias:    def.Alias,
			DataType: def.DataType,
			Value:    def.Value(d),
		})
	}

	payload := EncodePayload(seq, ts, metrics)
	topic := fmt.Sprintf("spBv1.0/%s/NDATA/%s", m.groupId, m.edgeNodeId)
	m.mqttClient.Publish(topic, 0, false, payload)

	m.mu.Lock()
	m.pubCount++
	m.mu.Unlock()
}

func (m *Model) publishSpDeath() {
	m.mu.Lock()
	bdSeq := m.bdSeq
	m.mu.Unlock()

	payload := EncodeDeath(bdSeq)
	topic := fmt.Sprintf("spBv1.0/%s/NDEATH/%s", m.groupId, m.edgeNodeId)
	tok := m.mqttClient.Publish(topic, 1, false, payload)
	tok.Wait()
}

// ── thin-edge.io publish ──────────────────────────────────────────────────────
//
// te/device/{node}///m/raw  — JSON object of all numeric metrics
// te/device/{node}///e/{n}  — JSON {"text":…} on event occurrence
// te/device/{node}///a/{n}  — JSON {"text":…} retained when alarm active
//                           — empty retained payload to clear

func (m *Model) teMeasurementTopic() string {
	return fmt.Sprintf("te/device/%s///m/raw", m.edgeNodeId)
}

func (m *Model) teEventTopic(name string) string {
	// thin-edge.io event type names must be URL-safe; replace spaces with _
	return fmt.Sprintf("te/device/%s///e/%s", m.edgeNodeId, strings.ReplaceAll(name, " ", "_"))
}

func (m *Model) teAlarmTopic(name string) string {
	return fmt.Sprintf("te/device/%s///a/%s", m.edgeNodeId, strings.ReplaceAll(name, " ", "_"))
}

// buildMeasurementPayload returns a JSON object of all current metric values.
func (m *Model) buildMeasurementPayload() []byte {
	d := m.device
	obj := make(map[string]interface{}, len(MetricDefs))
	for _, def := range MetricDefs {
		// Use the leaf name after the last "/" as the JSON key.
		key := def.Name
		if i := strings.LastIndex(def.Name, "/"); i >= 0 {
			key = def.Name[i+1:]
		}
		obj[key] = def.Value(d)
	}
	b, _ := json.Marshal(obj)
	return b
}

func (m *Model) publishTeBirth() {
	// Publish current measurements.
	m.mqttClient.Publish(m.teMeasurementTopic(), 0, false, m.buildMeasurementPayload())

	// Re-publish retained state for all currently active alarms so a
	// subscriber that just connected sees the right state.
	d := m.device
	alarms := map[string]*AlarmState{
		"HighSpindleTemp":       &d.AlarmHighSpindleTemp,
		"LowCoolantFlow":        &d.AlarmLowCoolantFlow,
		"HighHydraulicPressure": &d.AlarmHighHydraulicPressure,
		"EStop":                 &d.AlarmEStop,
	}
	for name, a := range alarms {
		if a.Active {
			payload, _ := json.Marshal(map[string]string{"text": name + " alarm active"})
			m.mqttClient.Publish(m.teAlarmTopic(name), 1, true, payload)
		}
	}

	m.mu.Lock()
	m.pubCount++
	m.mu.Unlock()
}

func (m *Model) publishTeData() {
	m.mqttClient.Publish(m.teMeasurementTopic(), 0, false, m.buildMeasurementPayload())

	m.mu.Lock()
	m.pubCount++
	m.mu.Unlock()
}

// publishTeEvents publishes events and alarm transitions as they occur.
func (m *Model) publishTeEvents(logs []LogEntry) {
	for _, e := range logs {
		switch e.Kind {
		case "event":
			payload, _ := json.Marshal(map[string]string{"text": e.Message})
			m.mqttClient.Publish(m.teEventTopic(e.Name), 0, false, payload)
		case "alarm":
			if e.Active {
				payload, _ := json.Marshal(map[string]string{"text": e.Message})
				m.mqttClient.Publish(m.teAlarmTopic(e.Name), 1, true, payload)
			} else {
				// Clear: publish empty retained payload to remove the retained message.
				m.mqttClient.Publish(m.teAlarmTopic(e.Name), 1, true, []byte{})
			}
		}
	}
}

// publishTeDeathClearAlarms removes all retained alarm messages on exit.
func (m *Model) publishTeDeathClearAlarms() {
	alarmNames := []string{"HighSpindleTemp", "LowCoolantFlow", "HighHydraulicPressure", "EStop"}
	for _, name := range alarmNames {
		tok := m.mqttClient.Publish(m.teAlarmTopic(name), 1, true, []byte{})
		tok.Wait()
	}
}

// connectMQTT establishes the MQTT connection.  In sparkplug mode it sets an
// NDEATH LWT and subscribes to NCMD.  In tedge mode it connects plainly.
func (m *Model) connectMQTT() mqtt.Client {
	opts := mqtt.NewClientOptions().
		AddBroker("tcp://" + m.broker).
		SetClientID(fmt.Sprintf("spdevice-%s-%d", m.edgeNodeId, time.Now().UnixMilli())).
		SetAutoReconnect(true).
		SetConnectRetryInterval(3 * time.Second)

	if m.mode != "tedge" {
		m.mu.Lock()
		bdSeq := m.bdSeq
		m.mu.Unlock()
		deathTopic := fmt.Sprintf("spBv1.0/%s/NDEATH/%s", m.groupId, m.edgeNodeId)
		deathPayload := EncodeDeath(bdSeq)
		opts.SetWill(deathTopic, string(deathPayload), 1, false)
	}

	ncmdTopic := fmt.Sprintf("spBv1.0/%s/NCMD/%s", m.groupId, m.edgeNodeId)

	opts.
		SetOnConnectHandler(func(c mqtt.Client) {
			if m.mode != "tedge" {
				// Sparkplug mode: increment bdSeq and subscribe to NCMD rebirth.
				m.mu.Lock()
				m.bdSeq++
				m.mu.Unlock()
				c.Subscribe(ncmdTopic, 0, func(_ mqtt.Client, msg mqtt.Message) {
					if isRebirthPayload(msg.Payload()) {
						select {
						case m.rebirthCh <- struct{}{}:
						default:
						}
					}
				})
			}
			m.connCh <- true
		}).
		SetConnectionLostHandler(func(_ mqtt.Client, _ error) {
			m.connCh <- false
		})

	client := mqtt.NewClient(opts)
	client.Connect()
	return client
}

// isRebirthPayload does a minimal protobuf scan looking for:
//
//	Metric { name="Node Control/Rebirth", boolean_value=true }
//
// Any message on the NCMD topic that contains this is a valid rebirth request.
func isRebirthPayload(data []byte) bool {
	// Scan payload for metrics (field 2, len-delimited)
	for i := 0; i < len(data); {
		if i >= len(data) {
			break
		}
		tag, n := decodeVarint(data, i)
		if n < 0 {
			break
		}
		i = n
		fieldNum := tag >> 3
		wireType := tag & 0x7
		if wireType == 2 {
			l, n := decodeVarint(data, i)
			if n < 0 {
				break
			}
			i = n
			end := i + int(l)
			if end > len(data) {
				break
			}
			metricData := data[i:end]
			i = end
			if fieldNum == 2 && isRebirthMetric(metricData) {
				return true
			}
		} else {
			i = skipField(data, i, wireType)
			if i < 0 {
				break
			}
		}
	}
	return false
}

func isRebirthMetric(data []byte) bool {
	name := ""
	boolVal := false
	hasBool := false
	for i := 0; i < len(data); {
		tag, n := decodeVarint(data, i)
		if n < 0 {
			break
		}
		i = n
		fieldNum := tag >> 3
		wireType := tag & 0x7
		if wireType == 0 {
			v, n := decodeVarint(data, i)
			if n < 0 {
				break
			}
			i = n
			if fieldNum == 14 {
				boolVal = v != 0
				hasBool = true
			}
		} else if wireType == 2 {
			l, n := decodeVarint(data, i)
			if n < 0 {
				break
			}
			i = n
			end := i + int(l)
			if end > len(data) {
				break
			}
			if fieldNum == 1 {
				name = string(data[i:end])
			}
			i = end
		} else {
			i = skipField(data, i, wireType)
			if i < 0 {
				break
			}
		}
	}
	return name == "Node Control/Rebirth" && hasBool && boolVal
}

func decodeVarint(data []byte, off int) (uint64, int) {
	var v uint64
	var shift uint
	for off < len(data) {
		b := data[off]
		off++
		v |= uint64(b&0x7F) << shift
		if b&0x80 == 0 {
			return v, off
		}
		shift += 7
		if shift >= 64 {
			return 0, -1
		}
	}
	return 0, -1
}

func skipField(data []byte, off int, wireType uint64) int {
	switch wireType {
	case 0:
		_, n := decodeVarint(data, off)
		return n
	case 1:
		return off + 8
	case 2:
		l, n := decodeVarint(data, off)
		if n < 0 {
			return -1
		}
		return n + int(l)
	case 5:
		return off + 4
	}
	return -1
}

// ── Display helpers ────────────────────────────────────────────────────────────

func formatVal(v interface{}, unit string) string {
	switch t := v.(type) {
	case float64:
		if t >= 1000 || t <= -1000 {
			return fmt.Sprintf("%.0f %s", t, unit)
		}
		return fmt.Sprintf("%.1f %s", t, unit)
	case int64:
		return fmt.Sprintf("%d %s", t, unit)
	case bool:
		if t {
			return "true"
		}
		return "false"
	case string:
		return t
	}
	return fmt.Sprintf("%v", v)
}

func toFloat64(v interface{}) (float64, bool) {
	switch t := v.(type) {
	case float64:
		return t, true
	case int64:
		return float64(t), true
	case float32:
		return float64(t), true
	}
	return 0, false
}

func truncate(s string, maxW int) string {
	if lipgloss.Width(s) <= maxW {
		return s
	}
	runes := []rune(s)
	for w := len(runes); w > 0; w-- {
		if lipgloss.Width(string(runes[:w])) <= maxW-1 {
			return string(runes[:w]) + "…"
		}
	}
	return ""
}

// ── Main ──────────────────────────────────────────────────────────────────────

func main() {
	broker := flag.String("broker", "localhost:1883", "MQTT broker host:port")
	mode := flag.String("mode", "sparkplug", `Publish mode: "sparkplug" (direct Sparkplug B) or "tedge" (thin-edge.io topics)`)
	groupId := flag.String("group", "tedge", "Sparkplug B Group ID (sparkplug mode only)")
	edgeNodeId := flag.String("node", "sim-cnc01", "Edge node / device ID")
	interval := flag.Duration("interval", 5*time.Second, "Minimum publish interval (e.g. 1s, 500ms, 5s)")
	flag.Parse()

	if *mode != "sparkplug" && *mode != "tedge" {
		fmt.Fprintf(os.Stderr, "error: --mode must be \"sparkplug\" or \"tedge\", got %q\n", *mode)
		os.Exit(1)
	}
	if *interval < 100*time.Millisecond {
		fmt.Fprintln(os.Stderr, "error: --interval must be at least 100ms")
		os.Exit(1)
	}

	m := newModel(*broker, *mode, *groupId, *edgeNodeId, *interval)
	m.mqttClient = m.connectMQTT()
	defer m.mqttClient.Disconnect(500)

	p := tea.NewProgram(m, tea.WithAltScreen(), tea.WithMouseCellMotion())
	if _, err := p.Run(); err != nil {
		log.Fatal(err)
	}
}
