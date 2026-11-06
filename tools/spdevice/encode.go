package main

// encode.go — Sparkplug B payload encoder using the official proto definition.
//
// Proto source: proto/sparkplug_b.proto (copied from the Sparkplug B spec).
// Regenerate Go bindings with:
//
//go:generate protoc --go_out=. --go_opt=module=github.com/thin-edge/tedge-flows-examples/tools/spdevice --go_opt=Mproto/sparkplug_b.proto=github.com/thin-edge/tedge-flows-examples/tools/spdevice/sparkplug proto/sparkplug_b.proto

import (
	"fmt"
	"time"

	sp "github.com/thin-edge/tedge-flows-examples/tools/spdevice/sparkplug"
	"google.golang.org/protobuf/proto"
)

// Sparkplug B datatype constants (from the specification).
const (
	spTypeInt32   uint32 = 3
	spTypeInt64   uint32 = 4
	spTypeUInt32  uint32 = 7
	spTypeUInt64  uint32 = 8
	spTypeDouble  uint32 = 10
	spTypeBoolean uint32 = 11
	spTypeString  uint32 = 12
)

// SpMetric is a single metric ready for encoding.
type SpMetric struct {
	Name     string // empty in DATA / alias-only messages
	Alias    uint64
	DataType uint32
	Value    interface{} // float64 | float32 | bool | string | int64 | int32 | uint64 | uint32
	IsNull   bool
}

// EncodePayload encodes a complete Sparkplug B payload.
func EncodePayload(seq uint64, ts time.Time, metrics []SpMetric) []byte {
	tsMs := uint64(ts.UnixMilli())
	pmetrics := make([]*sp.Payload_Metric, 0, len(metrics))
	for _, m := range metrics {
		pm := &sp.Payload_Metric{
			Alias:    proto.Uint64(m.Alias),
			Datatype: proto.Uint32(m.DataType),
		}
		if m.Name != "" {
			pm.Name = proto.String(m.Name)
			pm.Timestamp = proto.Uint64(tsMs)
		}
		if m.IsNull {
			pm.IsNull = proto.Bool(true)
		} else {
			setMetricValue(pm, m.Value)
		}
		pmetrics = append(pmetrics, pm)
	}

	payload := &sp.Payload{
		Timestamp: proto.Uint64(tsMs),
		Metrics:   pmetrics,
	}
	// Only encode seq when non-zero. seq=0 (BIRTH/DEATH) would serialise as the
	// trailing bytes 0x18 0x00; some MQTT brokers/clients strip the trailing null
	// byte, causing a "premature EOF" on the receiver side. Since seq is a proto2
	// optional field, omitting it is equivalent to seq=0 for all consumers.
	if seq > 0 {
		payload.Seq = proto.Uint64(seq)
	}
	data, err := proto.Marshal(payload)
	if err != nil {
		panic(fmt.Sprintf("sparkplug: failed to marshal payload: %v", err))
	}
	return data
}

// EncodeDeath encodes a minimal NDEATH payload containing only bdSeq.
func EncodeDeath(bdSeq uint64) []byte {
	return EncodePayload(0, time.Now(), []SpMetric{
		{Name: "bdSeq", Alias: 0, DataType: spTypeUInt64, Value: bdSeq},
	})
}

func setMetricValue(pm *sp.Payload_Metric, v interface{}) {
	switch val := v.(type) {
	case float64:
		pm.Value = &sp.Payload_Metric_DoubleValue{DoubleValue: val}
	case float32:
		pm.Value = &sp.Payload_Metric_FloatValue{FloatValue: val}
	case bool:
		pm.Value = &sp.Payload_Metric_BooleanValue{BooleanValue: val}
	case string:
		// An empty string_value encodes as a trailing 0x00 length byte, which
		// some MQTT brokers strip from retained payloads, causing "premature EOF"
		// on the receiver.  Use "-" as a placeholder so the field is never empty.
		s := val
		if s == "" {
			s = "-"
		}
		pm.Value = &sp.Payload_Metric_StringValue{StringValue: s}
	case int64:
		pm.Value = &sp.Payload_Metric_LongValue{LongValue: uint64(val)}
	case uint64:
		pm.Value = &sp.Payload_Metric_LongValue{LongValue: val}
	case int32:
		pm.Value = &sp.Payload_Metric_IntValue{IntValue: uint32(val)}
	case uint32:
		pm.Value = &sp.Payload_Metric_IntValue{IntValue: val}
	}
}
