package main

import (
	"encoding/base64"
	"fmt"
	"testing"
	"time"

	sp "github.com/thin-edge/tedge-flows-examples/tools/spdevice/sparkplug"
	"google.golang.org/protobuf/proto"
)

func unmarshalPayload(t *testing.T, data []byte) *sp.Payload {
	t.Helper()
	var p sp.Payload
	if err := proto.Unmarshal(data, &p); err != nil {
		t.Fatalf("proto.Unmarshal failed: %v", err)
	}
	return &p
}

func TestEncodePayloadValid(t *testing.T) {
	ts := time.Unix(1700000000, 0)

	tests := []struct {
		name    string
		seq     uint64
		metrics []SpMetric
	}{
		{name: "NBIRTH", seq: 0, metrics: []SpMetric{
			{Name: "bdSeq", Alias: 0, DataType: spTypeUInt64, Value: uint64(0)},
			{Name: "spindle.speed.rpm", Alias: 1, DataType: spTypeDouble, Value: float64(9876.5)},
			{Name: "cycle_count", Alias: 12, DataType: spTypeInt64, Value: int64(5)},
			{Name: "door.open", Alias: 14, DataType: spTypeBoolean, Value: false},
			{Name: "Alarm/BigName/Text", Alias: 21, DataType: spTypeString, Value: ""},
		}},
		{name: "NDATA", seq: 1, metrics: []SpMetric{
			{Alias: 1, DataType: spTypeDouble, Value: float64(1234.5)},
			{Alias: 14, DataType: spTypeBoolean, Value: true},
		}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			data := EncodePayload(tt.seq, ts, tt.metrics)
			t.Logf("payload %d bytes: %x", len(data), data)
			p := unmarshalPayload(t, data)
			if p.GetSeq() != tt.seq {
				t.Errorf("seq: got %d, want %d", p.GetSeq(), tt.seq)
			}
			if len(p.GetMetrics()) != len(tt.metrics) {
				t.Errorf("metric count: got %d, want %d", len(p.GetMetrics()), len(tt.metrics))
			}
		})
	}
}

func TestFullCycleBirth(t *testing.T) {
	d := NewDeviceState()
	ts := time.Now()

	var bm []SpMetric
	bm = append(bm, SpMetric{Name: "bdSeq", Alias: 0, DataType: spTypeUInt64, Value: uint64(0)})
	for _, def := range MetricDefs {
		bm = append(bm, SpMetric{Name: def.Name, Alias: def.Alias, DataType: def.DataType, Value: def.Value(d)})
	}
	birth := EncodePayload(0, ts, bm)
	t.Logf("NBIRTH %d bytes: %x", len(birth), birth)
	pb := unmarshalPayload(t, birth)
	if len(pb.GetMetrics()) != len(bm) {
		t.Errorf("NBIRTH metric count: got %d, want %d", len(pb.GetMetrics()), len(bm))
	}

	var dm []SpMetric
	for _, def := range MetricDefs {
		dm = append(dm, SpMetric{Alias: def.Alias, DataType: def.DataType, Value: def.Value(d)})
	}
	data := EncodePayload(1, ts, dm)
	t.Logf("NDATA %d bytes: %x", len(data), data)
	pd := unmarshalPayload(t, data)
	if len(pd.GetMetrics()) != len(dm) {
		t.Errorf("NDATA metric count: got %d, want %d", len(pd.GetMetrics()), len(dm))
	}
}

// TestGenerateFixtures prints stable base64 payloads for use in TypeScript tests.
// Run with: go test -v -run TestGenerateFixtures
func TestGenerateFixtures(t *testing.T) {
	// Fixed timestamp so the output is deterministic across runs
	ts := time.Unix(1750000000, 0)
	d := NewDeviceState()

	var bm []SpMetric
	bm = append(bm, SpMetric{Name: "bdSeq", Alias: 0, DataType: spTypeUInt64, Value: uint64(0)})
	for _, def := range MetricDefs {
		bm = append(bm, SpMetric{Name: def.Name, Alias: def.Alias, DataType: def.DataType, Value: def.Value(d)})
	}
	birth := EncodePayload(0, ts, bm)
	unmarshalPayload(t, birth) // ensure it round-trips cleanly in Go
	fmt.Printf("NBIRTH_B64=%s\n", base64.StdEncoding.EncodeToString(birth))

	seq14birth := EncodePayload(14, ts, bm)
	unmarshalPayload(t, seq14birth)
	fmt.Printf("NBIRTH_SEQ14_B64=%s\n", base64.StdEncoding.EncodeToString(seq14birth))
}
