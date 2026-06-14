package sparkplug

import "time"

// EncodeNCMDRebirth returns a minimal Sparkplug B NCMD payload bytes whose
// only metric is Node Control/Rebirth = true.
//
// Wire layout (proto2):
//
//	Payload {
//	  timestamp (field 1, varint) = now in milliseconds
//	  metrics   (field 2, len)    = Metric {
//	    name          (field 1, len)    = "Node Control/Rebirth"
//	    datatype      (field 4, varint) = 11  (Boolean)
//	    boolean_value (field 14, varint) = 1  (true)
//	  }
//	}
func EncodeNCMDRebirth() []byte {
	// ── inner Metric ──────────────────────────────────────────────────────────
	var metric []byte
	metric = appendLenField(metric, 1, []byte("Node Control/Rebirth")) // name
	metric = appendVarintField(metric, 4, uint64(DataTypeBoolean))     // datatype
	metric = appendVarintField(metric, 14, 1)                          // boolean_value = true

	// ── outer Payload ─────────────────────────────────────────────────────────
	var payload []byte
	payload = appendVarintField(payload, 1, uint64(time.Now().UnixMilli())) // timestamp
	payload = appendLenField(payload, 2, metric)                            // metrics[0]
	return payload
}

// appendVarintField writes a proto2 field with wire type 0 (varint).
func appendVarintField(buf []byte, fieldNum, value uint64) []byte {
	buf = appendRawVarint(buf, (fieldNum<<3)|0)
	buf = appendRawVarint(buf, value)
	return buf
}

// appendLenField writes a proto2 field with wire type 2 (length-delimited).
func appendLenField(buf []byte, fieldNum uint64, data []byte) []byte {
	buf = appendRawVarint(buf, (fieldNum<<3)|2)
	buf = appendRawVarint(buf, uint64(len(data)))
	return append(buf, data...)
}

func appendRawVarint(buf []byte, v uint64) []byte {
	for v >= 0x80 {
		buf = append(buf, byte(v)|0x80)
		v >>= 7
	}
	return append(buf, byte(v))
}
