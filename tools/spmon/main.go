package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"math"
	"os"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	mqtt "github.com/eclipse/paho.mqtt.golang"

	"github.com/thin-edge/tedge-flows-examples/tools/spmon/sparkplug"
)

// ─── Message types ────────────────────────────────────────────────────────────

type msgKind int

const (
	kindTedge     msgKind = iota // te/device/... JSON measurement
	kindSparkplug                // spBv1.0/... binary protobuf
	kindOther                    // anything else (shown as raw)
)

type MQTTMessage struct {
	ReceivedAt time.Time
	Topic      string
	Payload    []byte
	Kind       msgKind
}

func classifyTopic(topic string) msgKind {
	switch {
	case strings.HasPrefix(topic, "spBv1.0/"):
		return kindSparkplug
	case strings.HasPrefix(topic, "te/"):
		return kindTedge
	default:
		return kindOther
	}
}

// parseSparkplugTopic extracts the groupId and edgeNodeId from a Sparkplug B
// topic of the form spBv1.0/{groupId}/{cmd}/{edgeNodeId}[/{deviceId}].
// Returns empty strings if the topic does not match.
func parseSparkplugTopic(topic string) (groupId, edgeNodeId string) {
	// spBv1.0 / groupId / cmd / edgeNodeId [/ deviceId]
	parts := strings.SplitN(topic, "/", 5)
	if len(parts) >= 4 && parts[0] == "spBv1.0" {
		return parts[1], parts[3]
	}
	return "", ""
}

// ─── Styles ───────────────────────────────────────────────────────────────────

var (
	colorTedge     = lipgloss.Color("#00d7af") // teal
	colorSparkplug = lipgloss.Color("#ff8700") // orange
	colorOther     = lipgloss.Color("#8787d7") // lavender
	colorBorder    = lipgloss.Color("#444444")
	colorDim       = lipgloss.Color("#666666")
	colorHeader    = lipgloss.Color("#aaaaaa")

	styleTedge  = lipgloss.NewStyle().Foreground(colorTedge)
	styleSpark  = lipgloss.NewStyle().Foreground(colorSparkplug)
	styleOther  = lipgloss.NewStyle().Foreground(colorOther)
	styleDim    = lipgloss.NewStyle().Foreground(colorDim)
	styleHeader = lipgloss.NewStyle().Foreground(colorHeader).Bold(true)
	styleSel    = lipgloss.NewStyle().Background(lipgloss.Color("#005f87")).Foreground(lipgloss.Color("#ffffff")).Bold(true)
	styleHelp   = lipgloss.NewStyle().Foreground(colorDim)
)

func kindStyle(k msgKind) lipgloss.Style {
	switch k {
	case kindTedge:
		return styleTedge
	case kindSparkplug:
		return styleSpark
	default:
		return styleOther
	}
}

func kindIcon(k msgKind) string {
	switch k {
	case kindTedge:
		return "●"
	case kindSparkplug:
		return "◆"
	default:
		return "◉"
	}
}

// ─── Bubbletea model ──────────────────────────────────────────────────────────

const maxMessages = 500

type incomingMsg MQTTMessage
type connStatusMsg bool
type clearRebirthMsg struct{}

func clearRebirthAfter(d time.Duration) tea.Cmd {
	return tea.Tick(d, func(_ time.Time) tea.Msg {
		return clearRebirthMsg{}
	})
}

type Model struct {
	messages   []MQTTMessage
	selected   int
	follow     bool
	listOffset int

	detailVp    viewport.Model
	detailReady bool
	detailMeta  string // fixed header rendered above the scrollable viewport

	width  int
	height int

	connected bool
	broker    string

	// Sparkplug B NCMD rebirth
	mqttClient    mqtt.Client
	groupId       string
	edgeNodeId    string
	rebirthStatus string

	msgCh  <-chan MQTTMessage
	connCh <-chan bool
}

func newModel(broker string, mqttClient mqtt.Client, groupId, edgeNodeId string, msgCh <-chan MQTTMessage, connCh <-chan bool) Model {
	return Model{
		broker:     broker,
		follow:     true,
		mqttClient: mqttClient,
		groupId:    groupId,
		edgeNodeId: edgeNodeId,
		msgCh:      msgCh,
		connCh:     connCh,
	}
}

func waitForMQTT(ch <-chan MQTTMessage) tea.Cmd {
	return func() tea.Msg {
		return incomingMsg(<-ch)
	}
}

func waitForConnChange(ch <-chan bool) tea.Cmd {
	return func() tea.Msg {
		return connStatusMsg(<-ch)
	}
}

func (m Model) Init() tea.Cmd {
	return tea.Batch(waitForMQTT(m.msgCh), waitForConnChange(m.connCh))
}

// ─── Update ───────────────────────────────────────────────────────────────────

func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	var cmds []tea.Cmd
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		_, detailW := m.paneWidths()
		detailH := m.listHeight()
		if !m.detailReady {
			m.detailVp = viewport.New(detailW, detailH)
			m.detailReady = true
		}
		m.refreshDetail()
	case connStatusMsg:
		m.connected = bool(msg)
		cmds = append(cmds, waitForConnChange(m.connCh))
	case clearRebirthMsg:
		m.rebirthStatus = ""
	case incomingMsg:
		msg.Kind = classifyTopic(msg.Topic)
		if len(m.messages) >= maxMessages {
			m.messages = m.messages[1:]
			if m.selected > 0 {
				m.selected--
			}
		}
		m.messages = append(m.messages, MQTTMessage(msg))
		if m.follow {
			m.selected = len(m.messages) - 1
		}
		m.clampListOffset()
		m.refreshDetail()
		cmds = append(cmds, waitForMQTT(m.msgCh))
	case tea.KeyMsg:
		switch msg.String() {
		case "q", "ctrl+c":
			return m, tea.Quit
		case "up", "k":
			if m.selected > 0 {
				m.selected--
				m.follow = false
			}
			m.clampListOffset()
			m.detailVp.GotoTop()
			m.refreshDetail()
		case "down", "j":
			if m.selected < len(m.messages)-1 {
				m.selected++
				if m.selected == len(m.messages)-1 {
					m.follow = true
				}
			}
			m.clampListOffset()
			m.refreshDetail()
		case "G":
			if len(m.messages) > 0 {
				m.selected = len(m.messages) - 1
				m.follow = true
				m.clampListOffset()
				m.refreshDetail()
			}
		case "g":
			m.selected = 0
			m.follow = false
			m.listOffset = 0
			m.detailVp.GotoTop()
			m.refreshDetail()
		case "c":
			m.messages = nil
			m.selected = 0
			m.listOffset = 0
			m.follow = true
			m.detailMeta = ""
			m.detailVp.SetContent("")
		case "R":
			if m.connected && m.mqttClient != nil {
				// Prefer groupId/edgeNodeId from the selected (or nearest earlier)
				// Sparkplug B message so the user doesn't have to set flags manually.
				group, node := m.groupId, m.edgeNodeId
				for i := m.selected; i >= 0; i-- {
					if m.messages[i].Kind == kindSparkplug {
						g, n := parseSparkplugTopic(m.messages[i].Topic)
						if g != "" && n != "" {
							group, node = g, n
							break
						}
					}
				}
				if group != "" && node != "" {
					topic := fmt.Sprintf("spBv1.0/%s/NCMD/%s", group, node)
					payload := sparkplug.EncodeNCMDRebirth()
					m.mqttClient.Publish(topic, 0, false, payload)
					m.rebirthStatus = fmt.Sprintf("↺  Rebirth command sent → %s", topic)
					cmds = append(cmds, clearRebirthAfter(3*time.Second))
				}
			}
		case "pgdown", "ctrl+f":
			m.detailVp.HalfViewDown()
		case "pgup", "ctrl+b":
			m.detailVp.HalfViewUp()
		}
	}
	var vpCmd tea.Cmd
	m.detailVp, vpCmd = m.detailVp.Update(msg)
	cmds = append(cmds, vpCmd)
	return m, tea.Batch(cmds...)
}

// ─── Layout helpers ───────────────────────────────────────────────────────────

func (m Model) paneWidths() (int, int) {
	if m.width == 0 {
		return 30, 60
	}
	listW := m.width * 36 / 100
	detailW := m.width - listW - 3
	if listW < 20 {
		listW = 20
	}
	if detailW < 20 {
		detailW = 20
	}
	return listW, detailW
}

func (m Model) listHeight() int {
	h := m.height - 5
	if h < 1 {
		return 1
	}
	return h
}

func (m *Model) clampListOffset() {
	listH := m.listHeight()
	if m.selected < m.listOffset {
		m.listOffset = m.selected
	}
	if m.selected >= m.listOffset+listH {
		m.listOffset = m.selected - listH + 1
	}
	if m.listOffset < 0 {
		m.listOffset = 0
	}
}

// ─── View ─────────────────────────────────────────────────────────────────────

func (m Model) View() string {
	if m.width == 0 {
		return "Initialising…"
	}
	listW, detailW := m.paneWidths()
	listH := m.listHeight()

	connStatus := styleDim.Render("○ Connecting…")
	if m.connected {
		connStatus = styleTedge.Render("● Connected  ") + styleDim.Render(m.broker)
	}
	counter := ""
	if len(m.messages) > 0 {
		counter = styleDim.Render(fmt.Sprintf("  %d msgs", len(m.messages)))
	}
	header := lipgloss.PlaceHorizontal(
		m.width,
		lipgloss.Left,
		styleHeader.Render("spmon")+"  "+connStatus+counter,
	)

	listTitle := styleHeader.Render("Messages")
	if m.follow {
		listTitle += styleDim.Render(" [follow]")
	}
	var rows []string
	for i := m.listOffset; i < m.listOffset+listH && i < len(m.messages); i++ {
		msg := m.messages[i]
		icon := kindStyle(msg.Kind).Render(kindIcon(msg.Kind))
		ts := styleDim.Render(msg.ReceivedAt.Format("15:04:05.000"))
		size := formatSize(len(msg.Payload))
		topic := truncate(msg.Topic, listW-23) // 16 fixed + 1 space + 5 size + 1 space
		paddedTopic := fmt.Sprintf("%-*s", listW-23, topic)
		topicStr := kindStyle(msg.Kind).Render(paddedTopic)
		sizeStr := styleDim.Render(size)
		line := fmt.Sprintf("%s %s %s %s", icon, ts, topicStr, sizeStr)
		if i == m.selected {
			// Build from plain text so styleSel's background/foreground apply uniformly
			// across the entire row rather than being overridden by inner ANSI codes.
			plain := fmt.Sprintf("%s %s %-*s %s", kindIcon(msg.Kind), msg.ReceivedAt.Format("15:04:05.000"), listW-23, topic, size)
			line = styleSel.Width(listW).Render(plain)
		}
		rows = append(rows, line)
	}
	for len(rows) < listH {
		rows = append(rows, "")
	}
	listPane := lipgloss.NewStyle().
		Border(lipgloss.NormalBorder()).
		BorderForeground(colorBorder).
		Width(listW).
		Height(listH + 1).
		Render(listTitle + "\n" + strings.Join(rows, "\n"))

	detailTitle := styleHeader.Render("Detail")
	detailPane := lipgloss.NewStyle().
		Border(lipgloss.NormalBorder()).
		BorderForeground(colorBorder).
		Width(detailW).
		Height(listH + 1).
		Render(detailTitle + "\n" + m.detailMeta + m.detailVp.View())

	help := styleHelp.Render("  ↑/↓  select    scroll wheel / PgUp/PgDn  detail    g/G  top/bottom    c  clear    R  rebirth    q  quit")
	if m.rebirthStatus != "" {
		help = lipgloss.PlaceHorizontal(m.width, lipgloss.Left,
			styleTedge.Render("  "+m.rebirthStatus))
	}
	body := lipgloss.JoinHorizontal(lipgloss.Top, listPane, detailPane)
	return lipgloss.JoinVertical(lipgloss.Left, header, body, help)
}

// ─── Detail renderer ──────────────────────────────────────────────────────────

// refreshDetail recomputes the meta header and viewport body for the selected
// message, resizing the viewport to exactly fill the remaining space.
func (m *Model) refreshDetail() {
	if !m.detailReady {
		return
	}
	_, detailW := m.paneWidths()
	listH := m.listHeight()
	m.detailMeta = renderDetailMeta(m.messages, m.selected, detailW)
	// viewport height = total inner rows minus title(1) minus meta rows
	bodyH := listH - strings.Count(m.detailMeta, "\n")
	if bodyH < 1 {
		bodyH = 1
	}
	m.detailVp.Width = detailW
	m.detailVp.Height = bodyH
	m.detailVp.SetContent(renderDetailBody(m.messages, m.selected, detailW))
}

// renderDetailMeta returns the fixed header lines (always visible).
// It ends with a trailing newline so the viewport body starts on its own line.
func renderDetailMeta(messages []MQTTMessage, selected, detailW int) string {
	if len(messages) == 0 || selected >= len(messages) {
		return ""
	}
	msg := messages[selected]
	divider := styleDim.Render(strings.Repeat("─", detailW))
	var sb strings.Builder

	switch msg.Kind {
	case kindSparkplug:
		sp, err := sparkplug.Decode(msg.Payload)
		fmt.Fprintf(&sb, "%s\n", divider)
		fmt.Fprintf(&sb, "  %s  %s\n", styleHeader.Render("Topic:    "), kindStyle(msg.Kind).Render(truncate(msg.Topic, detailW-14)))
		if err != nil {
			fmt.Fprintf(&sb, "%s\n%s\n",
				lipgloss.NewStyle().Foreground(lipgloss.Color("#ff5f5f")).Render("  Decode error: "+err.Error()),
				divider)
			return sb.String()
		}
		if !sp.Timestamp.IsZero() {
			fmt.Fprintf(&sb, "  %s  %s\n", styleHeader.Render("Timestamp:"), sp.Timestamp.Format(time.RFC3339Nano))
		}
		fmt.Fprintf(&sb, "  %s  %d\n", styleHeader.Render("Seq:      "), sp.Seq)
		if sp.UUID != "" {
			fmt.Fprintf(&sb, "  %s  %s\n", styleHeader.Render("UUID:     "), sp.UUID)
		}
		fmt.Fprintf(&sb, "  %s  %s\n", styleHeader.Render("Size:     "), fmt.Sprintf("%d bytes", len(msg.Payload)))
		fmt.Fprintf(&sb, "%s\n", divider)
	default:
		fmt.Fprintf(&sb, "%s\n  %s  %s\n  %s  %s\n  %s  %s\n%s\n",
			divider,
			styleHeader.Render("Topic:   "), kindStyle(msg.Kind).Render(truncate(msg.Topic, detailW-14)),
			styleHeader.Render("Received:"), msg.ReceivedAt.Format(time.RFC3339Nano),
			styleHeader.Render("Size:    "), fmt.Sprintf("%d bytes", len(msg.Payload)),
			divider)
	}
	return sb.String()
}

// renderDetailBody returns only the scrollable payload content.
func renderDetailBody(messages []MQTTMessage, selected, detailW int) string {
	if len(messages) == 0 || selected >= len(messages) {
		return styleDim.Render("  No messages yet.")
	}
	msg := messages[selected]
	divider := styleDim.Render(strings.Repeat("─", detailW))
	var sb strings.Builder

	switch msg.Kind {
	case kindSparkplug:
		sp, err := sparkplug.Decode(msg.Payload)
		if err != nil {
			fmt.Fprintf(&sb, styleDim.Render("  Raw (%d bytes):\n  %x"), len(msg.Payload), msg.Payload)
			return sb.String()
		}
		const typeW = 10
		// Calculate name column width from the longest metric name in this payload,
		// capped so the table still fits in the pane.
		nameW := len("Name") // minimum: at least fits the header
		for _, metric := range sp.Metrics {
			n := metric.Name
			if n == "" {
				n = fmt.Sprintf("<alias %d>", metric.Alias)
			}
			if len(n) > nameW {
				nameW = len(n)
			}
		}
		// Leave room for: "  " indent + nameW + "  " + typeW + "  " + value
		maxNameW := detailW - typeW - 20
		if maxNameW < len("Name") {
			maxNameW = len("Name")
		}
		if nameW > maxNameW {
			nameW = maxNameW
		}
		// Section label + column headers pinned as the first lines of the body
		fmt.Fprintf(&sb, "  %s\n  %s\n",
			styleHeader.Render(fmt.Sprintf("Metrics (%d)", len(sp.Metrics))),
			divider)
		if len(sp.Metrics) == 0 {
			fmt.Fprintf(&sb, "  %s\n", styleDim.Render("(no metrics)"))
			return sb.String()
		}
		fmt.Fprintf(&sb, "  %s  %s  %s\n  %s\n",
			styleHeader.Render(pad("Name", nameW)),
			styleHeader.Render(pad("Type", typeW)),
			styleHeader.Render("Value"),
			divider)
		for _, metric := range sp.Metrics {
			name := metric.Name
			if name == "" {
				name = fmt.Sprintf("<alias %d>", metric.Alias)
			}
			line := fmt.Sprintf("  %s  %s  %s",
				kindStyle(kindSparkplug).Render(pad(truncate(name, nameW), nameW)),
				styleDim.Render(pad(sparkplug.DataTypeName(metric.DataType), typeW)),
				formatMetricValue(metric))
			if !metric.Timestamp.IsZero() && metric.Timestamp != sp.Timestamp {
				line += styleDim.Render(fmt.Sprintf("  @ %s", metric.Timestamp.Format("15:04:05.000")))
			}
			fmt.Fprintf(&sb, "%s\n", line)
		}
	default:
		pretty, err := prettyJSON(msg.Payload)
		if err != nil {
			fmt.Fprintf(&sb, "  %s\n", string(msg.Payload))
		} else {
			fmt.Fprintf(&sb, "%s\n", indentJSON(pretty, 2))
		}
	}
	return sb.String()
}

func formatMetricValue(m sparkplug.Metric) string {
	if m.IsNull {
		return styleDim.Render("null")
	}
	if m.Value == nil {
		return styleDim.Render("(complex)")
	}
	switch v := m.Value.(type) {
	case float64:
		if v == math.Trunc(v) {
			return fmt.Sprintf("%.1f", v)
		}
		return fmt.Sprintf("%g", v)
	case bool:
		if v {
			return styleTedge.Render("true")
		}
		return styleDim.Render("false")
	case int64:
		return fmt.Sprintf("%d", v)
	case string:
		return fmt.Sprintf("%q", v)
	case []byte:
		if len(v) > 16 {
			return fmt.Sprintf("0x%x… (%d bytes)", v[:16], len(v))
		}
		return fmt.Sprintf("0x%x", v)
	default:
		return fmt.Sprintf("%v", v)
	}
}

func prettyJSON(data []byte) (string, error) {
	var obj interface{}
	if err := json.Unmarshal(data, &obj); err != nil {
		return "", err
	}
	b, err := json.MarshalIndent(obj, "", "  ")
	return string(b), err
}

// indentJSON adds a left margin and colourises JSON key names.
func indentJSON(s string, indent int) string {
	prefix := strings.Repeat(" ", indent)
	var out []string
	for _, line := range strings.Split(s, "\n") {
		trimmed := strings.TrimLeft(line, " ")
		if len(trimmed) > 0 && trimmed[0] == '"' {
			if idx := strings.Index(trimmed, `": `); idx != -1 {
				spaces := strings.Repeat(" ", len(line)-len(trimmed))
				line = spaces + styleHeader.Render(trimmed[:idx+1]) + trimmed[idx+1:]
			}
		}
		out = append(out, prefix+line)
	}
	return strings.Join(out, "\n")
}

// ─── String utilities ─────────────────────────────────────────────────────────

func truncate(s string, max int) string {
	if max <= 3 {
		return s
	}
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	return string([]rune(s)[:max-1]) + "…"
}

func formatSize(n int) string {
	if n < 1000 {
		return fmt.Sprintf("%3d B", n) // 5 chars: "  0 B" .. "999 B"
	}
	return fmt.Sprintf("%4.1fk", float64(n)/1000) // 5 chars: " 1.2k" .. "99.9k"
}

func pad(s string, width int) string {
	n := utf8.RuneCountInString(s)
	if n >= width {
		return s
	}
	return s + strings.Repeat(" ", width-n)
}

// ─── MQTT ─────────────────────────────────────────────────────────────────────

func connectMQTT(broker string, topics []string, msgCh chan<- MQTTMessage, connCh chan<- bool) mqtt.Client {
	opts := mqtt.NewClientOptions().
		AddBroker("tcp://" + broker).
		SetClientID(fmt.Sprintf("spmon-%d", time.Now().UnixMilli())).
		SetAutoReconnect(true).
		SetConnectRetryInterval(3 * time.Second).
		SetOnConnectHandler(func(c mqtt.Client) {
			for _, topic := range topics {
				tok := c.Subscribe(topic, 0, func(_ mqtt.Client, m mqtt.Message) {
					payload := make([]byte, len(m.Payload()))
					copy(payload, m.Payload())
					msgCh <- MQTTMessage{
						ReceivedAt: time.Now(),
						Topic:      m.Topic(),
						Payload:    payload,
					}
				})
				tok.Wait()
			}
			connCh <- true
		}).
		SetConnectionLostHandler(func(_ mqtt.Client, _ error) {
			connCh <- false
		})
	c := mqtt.NewClient(opts)
	c.Connect().Wait()
	return c
}

// ─── Main ─────────────────────────────────────────────────────────────────────

var defaultTopics = []string{
	"spBv1.0/#",
	"te/device/+///m/",
	"te/device/+///m/+",
	"c8y/#",
}

func main() {
	broker := flag.String("broker", "localhost:1883", "MQTT broker host:port")
	topicFlag := flag.String("topics", "", "Comma-separated extra topics to subscribe to")
	groupId := flag.String("group", "tedge", "Sparkplug B Group ID (used for NCMD rebirth topic)")
	edgeNodeId := flag.String("node", "gateway01", "Sparkplug B Edge Node ID (used for NCMD rebirth topic)")
	flag.Parse()

	topics := append([]string{}, defaultTopics...)
	if *topicFlag != "" {
		for _, t := range strings.Split(*topicFlag, ",") {
			if t = strings.TrimSpace(t); t != "" {
				topics = append(topics, t)
			}
		}
	}

	msgCh := make(chan MQTTMessage, 256)
	connCh := make(chan bool, 4)
	client := connectMQTT(*broker, topics, msgCh, connCh)
	defer client.Disconnect(250)

	m := newModel(*broker, client, *groupId, *edgeNodeId, msgCh, connCh)
	p := tea.NewProgram(m, tea.WithAltScreen(), tea.WithMouseCellMotion())
	if _, err := p.Run(); err != nil {
		log.Fatal(err)
		os.Exit(1)
	}
}
