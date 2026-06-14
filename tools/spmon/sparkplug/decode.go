// Package sparkplug provides a minimal hand-rolled proto2 wire-format decoder
// for Sparkplug B payloads.  No protoc / code-generation is required.
package sparkplug

import (
	"encoding/binary"
	"fmt"
	"math"
	"time"
)

// DataType constants from the Sparkplug B specification (section 6.4.16).
const (
	DataTypeInt8     uint32 = 1
	DataTypeInt16    uint32 = 2
	DataTypeInt32    uint32 = 3
	DataTypeInt64    uint32 = 4
	DataTypeUInt8    uint32 = 5
	DataTypeUInt16   uint32 = 6
	DataTypeUInt32   uint32 = 7
	DataTypeUInt64   uint32 = 8
	DataTypeFloat    uint32 = 9
	DataTypeDouble   uint32 = 10
	DataTypeBoolean  uint32 = 11
	DataTypeString   uint32 = 12
	DataTypeDateTime uint32 = 13
	DataTypeText     uint32 = 14
	DataTypeUUID     uint32 = 15
	DataTypeDataSet  uint32 = 16
	DataTypeBytes    uint32 = 17
	DataTypeFile     uint32 = 18
	DataTypeTemplate uint32 = 19
)

var dataTypeNames = map[uint32]string{
	1: "Int8", 2: "Int16", 3: "Int32", 4: "Int64",
	5: "UInt8", 6: "UInt16", 7: "UInt32", 8: "UInt64",
	9: "Float", 10: "Double", 11: "Boolean", 12: "String",
	13: "DateTime", 14: "Text", 15: "UUID", 16: "DataSet",
	17: "Bytes", 18: "File", 19: "Template",
}

// DataTypeName returns a human-readable name for a Sparkplug B data type.
func DataTypeName(dt uint32) string {
	if name, ok := dataTypeNames[dt]; ok {
		return name
	}
	return fmt.Sprintf("Unknown(%d)", dt)
}

// Metric represents a single Sparkplug B metric.
type Metric struct {
	Name      string
	Alias     uint64
	Timestamp time.Time
	DataType  uint32
	IsNull    bool
	// Value holds the decoded scalar: int64, float64, bool, string, or []byte.
	// Nil when IsNull is true or the value type is unsupported.
	Value interface{}
}

// Payload is a decoded Sparkplug B payload.
type Payload struct {
	Timestamp time.Time
	Seq       uint64
	UUID      string
	Metrics   []Metric
}

// ─── proto2 wire-format primitives ───────────────────────────────────────────

func readVarint(data []byte, off int) (uint64, int, error) {
	var v uint64
	var shift uint
	for {
		if off >= len(data) {
			return 0, off, fmt.Errorf("sparkplug: varint truncated at offset %d", off)
		}
		b := data[off]
		off++
		v |= uint64(b&0x7F) << shift
		if b&0x80 == 0 {
			return v, off, nil
		}
		shift += 7
		if shift >= 64 {
			return 0, off, fmt.Errorf("sparkplug: varint overflow")
		}
	}
}

func readBytes(data []byte, off int) ([]byte, int, error) {
	length, off, err := readVarint(data, off)
	if err != nil {
		return nil, off, err
	}
	end := off + int(length)
	if end > len(data) {
		return nil, off, fmt.Errorf("sparkplug: length-delimited field extends past end of data (need %d, have %d)", end, len(data))
	}
	return data[off:end], end, nil
}

// skipField discards one field value given its wire type.
func skipField(data []byte, off int, wireType uint64) (int, error) {
	switch wireType {
	case 0: // varint
		_, off, err := readVarint(data, off)
		return off, err
	case 1: // 64-bit
		if off+8 > len(data) {
			return off, fmt.Errorf("sparkplug: 64-bit field truncated")
		}
		return off + 8, nil
	case 2: // length-delimited
		_, off, err := readBytes(data, off)
		return off, err
	case 5: // 32-bit
		if off+4 > len(data) {
			return off, fmt.Errorf("sparkplug: 32-bit field truncated")
		}
		return off + 4, nil
	default:
		return off, fmt.Errorf("sparkplug: unsupported wire type %d", wireType)
	}
}

var epoch = time.Unix(0, 0).UTC()

func msToTime(ms uint64) time.Time {
	if ms == 0 {
		return time.Time{}
	}
	return time.UnixMilli(int64(ms)).UTC()
}

// ─── Metric decoder ──────────────────────────────────────────────────────────

func decodeMetric(data []byte) (Metric, error) {
	var m Metric
	off := 0
	for off < len(data) {
		tag, n, err := readVarint(data, off)
		if err != nil {
			return m, err
		}
		off = n
		fieldNum := tag >> 3
		wireType := tag & 0x7

		switch {
		// --- varint fields ---
		case wireType == 0:
			v, n, err := readVarint(data, off)
			if err != nil {
				return m, err
			}
			off = n
			switch fieldNum {
			case 2:
				m.Alias = v
			case 3:
				m.Timestamp = msToTime(v)
			case 4:
				m.DataType = uint32(v)
			case 7:
				m.IsNull = v != 0
			case 10: // int_value (uint32 in proto)
				m.Value = int64(int32(v))
			case 11: // long_value (uint64)
				m.Value = int64(v)
			case 14: // boolean_value
				m.Value = v != 0
			}

		// --- 64-bit fields ---
		case wireType == 1:
			if off+8 > len(data) {
				return m, fmt.Errorf("sparkplug: 64-bit field truncated")
			}
			bits := binary.LittleEndian.Uint64(data[off : off+8])
			off += 8
			if fieldNum == 13 { // double_value
				m.Value = math.Float64frombits(bits)
			}

		// --- length-delimited fields ---
		case wireType == 2:
			b, n, err := readBytes(data, off)
			if err != nil {
				return m, err
			}
			off = n
			switch fieldNum {
			case 1: // name
				m.Name = string(b)
			case 15: // string_value
				m.Value = string(b)
			case 16: // bytes_value
				cp := make([]byte, len(b))
				copy(cp, b)
				m.Value = cp
			}

		// --- 32-bit fields ---
		case wireType == 5:
			if off+4 > len(data) {
				return m, fmt.Errorf("sparkplug: 32-bit field truncated")
			}
			bits := binary.LittleEndian.Uint32(data[off : off+4])
			off += 4
			if fieldNum == 12 { // float_value
				m.Value = float64(math.Float32frombits(bits))
			}

		default:
			// Skip unknown fields gracefully.
			n, err := skipField(data, off, wireType)
			if err != nil {
				return m, err
			}
			off = n
		}
	}
	return m, nil
}

// ─── Public API ──────────────────────────────────────────────────────────────

// Decode parses a binary Sparkplug B payload.
func Decode(data []byte) (*Payload, error) {
	var p Payload
	off := 0
	for off < len(data) {
		tag, n, err := readVarint(data, off)
		if err != nil {
			return &p, err
		}
		off = n
		fieldNum := tag >> 3
		wireType := tag & 0x7

		switch {
		case wireType == 0:
			v, n, err := readVarint(data, off)
			if err != nil {
				return &p, err
			}
			off = n
			switch fieldNum {
			case 1:
				p.Timestamp = msToTime(v)
			case 3:
				p.Seq = v
			}

		case wireType == 2:
			b, n, err := readBytes(data, off)
			if err != nil {
				return &p, err
			}
			off = n
			switch fieldNum {
			case 2: // repeated Metric
				metric, err := decodeMetric(b)
				if err != nil {
					return &p, fmt.Errorf("sparkplug: decoding metric: %w", err)
				}
				p.Metrics = append(p.Metrics, metric)
			case 4: // uuid
				p.UUID = string(b)
			}

		default:
			n, err := skipField(data, off, wireType)
			if err != nil {
				return &p, err
			}
			off = n
		}
	}
	return &p, nil
}
