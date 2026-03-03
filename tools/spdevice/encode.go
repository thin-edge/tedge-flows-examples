package main

// encode.go — minimal hand-rolled Sparkplug B protobuf encoder.
//
// Field numbers are taken directly from the Sparkplug B specification and
// cross-checked against the decoder in tools/spmon/sparkplug/decode.go.
//
// Payload fields:
//   1 (varint)  timestamp  – milliseconds since epoch
//   2 (len, repeated) metrics
//   3 (varint)  seq        – 0–255, wraps
//
// Metric fields:
//   1  (len)     name         – only in BIRTH; omitted in DATA (alias-only)
//   2  (varint)  alias        – uint64
//   3  (varint)  timestamp    – milliseconds since epoch (per-metric, optional)
//   4  (varint)  datatype
//   7  (varint)  is_null
//   10 (varint)  int_value    – Int8/16/32, UInt8/16/32
//   11 (varint)  long_value   – Int64, UInt64, DateTime
//   12 (fixed32) float_value
//   13 (fixed64) double_value
//   14 (varint)  boolean_value
//   15 (len)     string_value

import (
	"encoding/binary"
	"math"
	"time"
)

// Sparkplug B datatype constants.
const (
	spTypeInt32   uint32 = 3
	spTypeInt64   uint32 = 4
	spTypeUInt32  uint32 = 7
	spTypeUInt64  uint32 = 8
	spTypeDouble  uint32 = 10
	spTypeBoolean uint32 = 11
	spTypeString  uint32 = 12
)

// SpMetric is a single metric ready for wire encoding.
type SpMetric struct {
	Name     string // empty in DATA/alias-only messages
	Alias    uint64
	DataType uint32
	Value    interface{} // float64 | bool | string | int64 | uint64
	IsNull   bool
}

// EncodePayload encodes a complete Sparkplug B payload.
func EncodePayload(seq uint64, ts time.Time, metrics []SpMetric) []byte {
	tsMs := uint64(ts.UnixMilli())
	var buf []byte
	buf = appendVarintField(buf, 1, tsMs) // timestamp
	buf = appendVarintField(buf, 3, seq)  // seq
	for _, m := range metrics {
		buf = appendLenField(buf, 2, encodeMetric(m, tsMs))
	}
	return buf
}

// EncodeDeath encodes a minimal NDEATH payload containing only bdSeq.
func EncodeDeath(bdSeq uint64) []byte {
	return EncodePayload(0, time.Now(), []SpMetric{
		{Name: "bdSeq", Alias: 0, DataType: spTypeUInt64, Value: bdSeq},
	})
}

func encodeMetric(m SpMetric, tsMs uint64) []byte {
	var buf []byte
	if m.Name != "" {
		buf = appendLenField(buf, 1, []byte(m.Name)) // name (BIRTH only)
		buf = appendVarintField(buf, 3, tsMs)        // per-metric timestamp
	}
	buf = appendVarintField(buf, 2, m.Alias)            // alias
	buf = appendVarintField(buf, 4, uint64(m.DataType)) // datatype
	if m.IsNull {
		buf = appendVarintField(buf, 7, 1)
		return buf
	}
	switch v := m.Value.(type) {
	case float64:
		buf = appendFixed64Field(buf, 13, math.Float64bits(v))
	case float32:
		buf = appendFixed32Field(buf, 12, math.Float32bits(v))
	case bool:
		bv := uint64(0)
		if v {
			bv = 1
		}
		buf = appendVarintField(buf, 14, bv)
	case string:
		buf = appendLenField(buf, 15, []byte(v))
	case int64:
		buf = appendVarintField(buf, 11, uint64(v))
	case uint64:
		buf = appendVarintField(buf, 11, v)
	case int32:
		buf = appendVarintField(buf, 10, uint64(v))
	case uint32:
		buf = appendVarintField(buf, 10, uint64(v))
	}
	return buf
}

// ── proto2 wire helpers ───────────────────────────────────────────────────────

func appendVarintField(buf []byte, fieldNum, value uint64) []byte {
	buf = appendRawVarint(buf, (fieldNum<<3)|0)
	buf = appendRawVarint(buf, value)
	return buf
}

func appendLenField(buf []byte, fieldNum uint64, data []byte) []byte {
	buf = appendRawVarint(buf, (fieldNum<<3)|2)
	buf = appendRawVarint(buf, uint64(len(data)))
	return append(buf, data...)
}

func appendFixed64Field(buf []byte, fieldNum, value uint64) []byte {
	buf = appendRawVarint(buf, (fieldNum<<3)|1)
	b := make([]byte, 8)
	binary.LittleEndian.PutUint64(b, value)
	return append(buf, b...)
}

func appendFixed32Field(buf []byte, fieldNum uint32, value uint32) []byte {
	buf = appendRawVarint(buf, (uint64(fieldNum)<<3)|5)
	b := make([]byte, 4)
	binary.LittleEndian.PutUint32(b, value)
	return append(buf, b...)
}

func appendRawVarint(buf []byte, v uint64) []byte {
	for v >= 0x80 {
		buf = append(buf, byte(v)|0x80)
		v >>= 7
	}
	return append(buf, byte(v))
}
