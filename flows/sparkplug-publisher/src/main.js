"use strict";
var __assign =
  (this && this.__assign) ||
  function () {
    __assign =
      Object.assign ||
      function (t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
          s = arguments[i];
          for (var p in s)
            if (Object.prototype.hasOwnProperty.call(s, p)) t[p] = s[p];
        }
        return t;
      };
    return __assign.apply(this, arguments);
  };
Object.defineProperty(exports, "__esModule", { value: true });
exports.onMessage = onMessage;
var tedge_1 = require("../../common/tedge");
var protobuf_1 = require("@bufbuild/protobuf");
var sparkplug_b_pb_1 = require("./gen/sparkplug_b_pb");
// Sparkplug B datatype constants
var DataType = {
  Double: 10,
  Boolean: 11,
  String: 12,
};
/** Load the alias registry for a device from persistent flow state. */
function getDeviceRegistry(context, deviceId) {
  var raw = context.flow.get("alias:".concat(deviceId));
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (_a) {
    return {};
  }
}
/** Save the alias registry for a device back to flow state. */
function saveDeviceRegistry(context, deviceId, registry) {
  context.flow.set("alias:".concat(deviceId), JSON.stringify(registry));
  // Track the next free alias number alongside the registry.
  var highest =
    Object.values(registry).reduce(function (max, m) {
      return Math.max(max, m.alias);
    }, -1) + 1;
  context.flow.set("nextAlias:".concat(deviceId), highest);
}
/** Return the next free alias integer for a device. */
function getNextAlias(context, deviceId) {
  var _a;
  return (_a = context.flow.get("nextAlias:".concat(deviceId))) !== null &&
    _a !== void 0
    ? _a
    : 0;
}
// thin-edge.io measurement topic: te/device/{name}///m/{type}
// Returns null if the topic does not match.
function parseTedgeMeasurementTopic(topic) {
  var _a;
  var parts = topic.split("/");
  // Expected: ["te", "device", "{name}", "", "", "m", "{type?}"]
  if (parts.length < 6 || parts[0] !== "te" || parts[5] !== "m") {
    return null;
  }
  return {
    deviceId: parts[2],
    measurementType: (_a = parts[6]) !== null && _a !== void 0 ? _a : "",
  };
}
/** Classify a raw payload value into a Sparkplug B typed metric value + datatype. */
function classifyValue(rawValue) {
  if (typeof rawValue === "number") {
    return {
      value: { case: "doubleValue", value: rawValue },
      datatype: DataType.Double,
    };
  } else if (typeof rawValue === "boolean") {
    return {
      value: { case: "booleanValue", value: rawValue },
      datatype: DataType.Boolean,
    };
  } else if (typeof rawValue === "string") {
    return {
      value: { case: "stringValue", value: rawValue },
      datatype: DataType.String,
    };
  }
  // Skip complex types (objects, arrays) that have no direct Sparkplug B scalar mapping.
  return null;
}
/** Advance the rolling 0-255 Sparkplug B sequence number and return it. */
function nextSeq(context) {
  var _a;
  var prev = (_a = context.flow.get("seq")) !== null && _a !== void 0 ? _a : -1;
  var seq = (prev + 1) % 256;
  context.flow.set("seq", seq);
  return BigInt(seq);
}
function onMessage(message, context) {
  var _a = context.config,
    groupId = _a.groupId,
    edgeNodeId = _a.edgeNodeId,
    _b = _a.debug,
    debug = _b === void 0 ? false : _b;
  if (!groupId || !edgeNodeId) {
    if (debug)
      console.error(
        "sparkplug-publisher: groupId and edgeNodeId must be configured",
      );
    return [];
  }
  var parsed = parseTedgeMeasurementTopic(message.topic);
  if (!parsed) return [];
  var deviceId = parsed.deviceId;
  var tedgePayload;
  try {
    tedgePayload = (0, tedge_1.decodeJsonPayload)(message.payload);
  } catch (e) {
    if (debug)
      console.error("sparkplug-publisher: failed to parse JSON payload", e);
    return [];
  }
  // Resolve the measurement timestamp; fall back to message receive time.
  var timeField = tedgePayload["time"];
  var timestamp =
    typeof timeField === "string" ? new Date(timeField) : message.time;
  var timestampMs = BigInt(timestamp.getTime());
  var incoming = [];
  for (var _i = 0, _c = Object.entries(tedgePayload); _i < _c.length; _i++) {
    var _d = _c[_i],
      key = _d[0],
      rawValue = _d[1];
    if (key === "time") continue;
    var typed = classifyValue(rawValue);
    if (!typed) continue;
    incoming.push(__assign({ name: key }, typed));
  }
  if (incoming.length === 0) return [];
  // ── Alias registry ────────────────────────────────────────────────────────
  // Each device's metric names are mapped to stable integer aliases once in a
  // BIRTH message. Subsequent DATA messages carry only the alias, not the name,
  // saving bandwidth on every measurement update.
  var registry = getDeviceRegistry(context, deviceId);
  var needsBirth = Object.keys(registry).length === 0; // first time we see this device
  var nextAlias = getNextAlias(context, deviceId);
  for (var _e = 0, incoming_1 = incoming; _e < incoming_1.length; _e++) {
    var metric = incoming_1[_e];
    if (!(metric.name in registry)) {
      registry[metric.name] = { alias: nextAlias++, datatype: metric.datatype };
      needsBirth = true; // new metric appeared → must re-issue BIRTH
    }
  }
  if (needsBirth) {
    saveDeviceRegistry(context, deviceId, registry);
  }
  // ── Topic construction ────────────────────────────────────────────────────
  var isEdgeNode = deviceId === edgeNodeId;
  var birthCmd = isEdgeNode ? "NBIRTH" : "DBIRTH";
  var dataCmd = isEdgeNode ? "NDATA" : "DDATA";
  var birthTopic = isEdgeNode
    ? "spBv1.0/".concat(groupId, "/").concat(birthCmd, "/").concat(edgeNodeId)
    : "spBv1.0/"
        .concat(groupId, "/")
        .concat(birthCmd, "/")
        .concat(edgeNodeId, "/")
        .concat(deviceId);
  var dataTopic = isEdgeNode
    ? "spBv1.0/".concat(groupId, "/").concat(dataCmd, "/").concat(edgeNodeId)
    : "spBv1.0/"
        .concat(groupId, "/")
        .concat(dataCmd, "/")
        .concat(edgeNodeId, "/")
        .concat(deviceId);
  var output = [];
  // ── BIRTH message (retained, full names + aliases, current values) ────────
  // The Sparkplug B spec requires BIRTH to be published as a retained MQTT
  // message so that any host application joining later can reconstruct the
  // alias→name mapping without waiting for the next DATA.
  //
  // Note: NDEATH should be configured as the MQTT Will with the bdSeq counter
  // at connection time — that happens outside the flow (in the MQTT client
  // configuration), not here.
  if (needsBirth) {
    var birthMetrics = incoming.map(function (m) {
      var _a = registry[m.name],
        alias = _a.alias,
        datatype = _a.datatype;
      return (0, protobuf_1.create)(sparkplug_b_pb_1.Payload_MetricSchema, {
        name: m.name, // full name only in BIRTH
        alias: BigInt(alias), // alias defined here, reused in all DATA
        timestamp: timestampMs,
        datatype: datatype,
        value: m.value,
      });
    });
    output.push({
      time: timestamp,
      topic: birthTopic,
      payload: (0, protobuf_1.toBinary)(
        sparkplug_b_pb_1.PayloadSchema,
        (0, protobuf_1.create)(sparkplug_b_pb_1.PayloadSchema, {
          timestamp: timestampMs,
          seq: nextSeq(context),
          metrics: birthMetrics,
        }),
      ),
      mqtt: { retain: true, qos: 1 },
    });
  }
  // ── DATA message (alias only — no metric names on the wire) ───────────────
  var dataMetrics = incoming.map(function (m) {
    var _a = registry[m.name],
      alias = _a.alias,
      datatype = _a.datatype;
    return (0, protobuf_1.create)(sparkplug_b_pb_1.Payload_MetricSchema, {
      // name intentionally omitted — consumers resolve via the BIRTH alias map
      alias: BigInt(alias),
      timestamp: timestampMs,
      datatype: datatype,
      value: m.value,
    });
  });
  output.push({
    time: timestamp,
    topic: dataTopic,
    payload: (0, protobuf_1.toBinary)(
      sparkplug_b_pb_1.PayloadSchema,
      (0, protobuf_1.create)(sparkplug_b_pb_1.PayloadSchema, {
        timestamp: timestampMs,
        seq: nextSeq(context),
        metrics: dataMetrics,
      }),
    ),
  });
  return output;
}
