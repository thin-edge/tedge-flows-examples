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
var globals_1 = require("@jest/globals");
var tedge = require("../../common/tedge");
var flow = require("../src/main");
var protobuf_1 = require("@bufbuild/protobuf");
var sparkplug_b_pb_1 = require("../src/gen/sparkplug_b_pb");
var BASE_CONFIG = {
  groupId: "my-factory",
  edgeNodeId: "gateway01",
};
function makeMessage(topic, payload, time) {
  if (time === void 0) {
    time = new Date("2026-02-25T10:00:00.000Z");
  }
  return { time: time, topic: topic, payload: JSON.stringify(payload) };
}
/** Find a message in output whose topic contains the given Sparkplug B command (e.g. "DDATA"). */
function findMsg(output, cmd) {
  return output.find(function (m) {
    return m.topic.includes("/".concat(cmd, "/"));
  });
}
(0, globals_1.describe)("sparkplug-publisher", function () {
  // ── Birth / death certificates ────────────────────────────────────────────
  (0, globals_1.test)(
    "first message from a device emits DBIRTH followed by DDATA",
    function () {
      var ctx = tedge.createContext(BASE_CONFIG);
      var output = flow.onMessage(
        makeMessage("te/device/sensor01///m/", { temperature: 23.5 }),
        ctx,
      );
      // Two messages: [DBIRTH, DDATA]
      (0, globals_1.expect)(output).toHaveLength(2);
      (0, globals_1.expect)(output[0].topic).toBe(
        "spBv1.0/my-factory/DBIRTH/gateway01/sensor01",
      );
      (0, globals_1.expect)(output[1].topic).toBe(
        "spBv1.0/my-factory/DDATA/gateway01/sensor01",
      );
    },
  );
  (0, globals_1.test)(
    "BIRTH message is published as a retained MQTT message",
    function () {
      var _a, _b;
      var ctx = tedge.createContext(BASE_CONFIG);
      var output = flow.onMessage(
        makeMessage("te/device/sensor01///m/", { temperature: 23.5 }),
        ctx,
      );
      var birth = findMsg(output, "DBIRTH");
      (0, globals_1.expect)(
        (_a = birth.mqtt) === null || _a === void 0 ? void 0 : _a.retain,
      ).toBe(true);
      (0, globals_1.expect)(
        (_b = birth.mqtt) === null || _b === void 0 ? void 0 : _b.qos,
      ).toBe(1);
    },
  );
  (0, globals_1.test)(
    "BIRTH metrics carry both full name and alias; DATA metrics carry alias only",
    function () {
      var ctx = tedge.createContext(BASE_CONFIG);
      var output = flow.onMessage(
        makeMessage("te/device/sensor01///m/", { temperature: 23.5 }),
        ctx,
      );
      var birthPayload = (0, protobuf_1.fromBinary)(
        sparkplug_b_pb_1.PayloadSchema,
        findMsg(output, "DBIRTH").payload,
      );
      (0, globals_1.expect)(birthPayload.metrics[0].name).toBe("temperature");
      // alias is a bigint; any defined value is valid
      (0, globals_1.expect)(typeof birthPayload.metrics[0].alias).toBe(
        "bigint",
      );
      var dataPayload = (0, protobuf_1.fromBinary)(
        sparkplug_b_pb_1.PayloadSchema,
        findMsg(output, "DDATA").payload,
      );
      // DATA must not repeat the name — consumers use the BIRTH alias map
      (0, globals_1.expect)(dataPayload.metrics[0].name).toBe("");
      (0, globals_1.expect)(dataPayload.metrics[0].alias).toBe(
        birthPayload.metrics[0].alias,
      );
    },
  );
  (0, globals_1.test)(
    "second message from same device emits DDATA only (no BIRTH)",
    function () {
      var _a;
      var ctx = tedge.createContext(BASE_CONFIG);
      var msg = function () {
        return makeMessage("te/device/sensor01///m/", { temperature: 23.5 });
      };
      flow.onMessage(msg(), ctx); // first — triggers birth
      var second = flow.onMessage(msg(), ctx);
      (0, globals_1.expect)(second).toHaveLength(1);
      (0, globals_1.expect)(second[0].topic).toContain("/DDATA/");
      (0, globals_1.expect)(
        (_a = second[0].mqtt) === null || _a === void 0 ? void 0 : _a.retain,
      ).toBeUndefined();
    },
  );
  (0, globals_1.test)(
    "new metric appearing on a subsequent message re-issues BIRTH",
    function () {
      var ctx = tedge.createContext(BASE_CONFIG);
      flow.onMessage(
        makeMessage("te/device/sensor01///m/", { temperature: 23.5 }),
        ctx,
      );
      var output2 = flow.onMessage(
        makeMessage("te/device/sensor01///m/", {
          temperature: 24.0,
          humidity: 60.0, // new metric
        }),
        ctx,
      );
      // BIRTH re-issued because alias registry grew
      (0, globals_1.expect)(output2).toHaveLength(2);
      var birth2 = (0, protobuf_1.fromBinary)(
        sparkplug_b_pb_1.PayloadSchema,
        findMsg(output2, "DBIRTH").payload,
      );
      var names = birth2.metrics.map(function (m) {
        return m.name;
      });
      (0, globals_1.expect)(names).toContain("temperature");
      (0, globals_1.expect)(names).toContain("humidity");
    },
  );
  (0, globals_1.test)(
    "alias assigned at first BIRTH is reused unchanged in later DATA",
    function () {
      var ctx = tedge.createContext(BASE_CONFIG);
      var first = flow.onMessage(
        makeMessage("te/device/sensor01///m/", { temperature: 23.5 }),
        ctx,
      );
      var birthAlias = (0, protobuf_1.fromBinary)(
        sparkplug_b_pb_1.PayloadSchema,
        findMsg(first, "DBIRTH").payload,
      ).metrics[0].alias;
      var second = flow.onMessage(
        makeMessage("te/device/sensor01///m/", { temperature: 24.0 }),
        ctx,
      );
      var dataAlias = (0, protobuf_1.fromBinary)(
        sparkplug_b_pb_1.PayloadSchema,
        second[0].payload,
      ).metrics[0].alias;
      (0, globals_1.expect)(dataAlias).toBe(birthAlias);
    },
  );
  (0, globals_1.test)(
    "different devices have independent alias registries",
    function () {
      var ctx = tedge.createContext(BASE_CONFIG);
      flow.onMessage(
        makeMessage("te/device/sensor01///m/", { temperature: 1.0 }),
        ctx,
      );
      var out2 = flow.onMessage(
        makeMessage("te/device/sensor02///m/", { temperature: 2.0 }),
        ctx,
      );
      // sensor02 triggers its own BIRTH (independent of sensor01)
      (0, globals_1.expect)(out2).toHaveLength(2);
      (0, globals_1.expect)(out2[0].topic).toContain("sensor02");
    },
  );
  // ── Topic / metric mapping ────────────────────────────────────────────────
  (0, globals_1.test)("child device maps to DDATA topic", function () {
    var ctx = tedge.createContext(BASE_CONFIG);
    var output = flow.onMessage(
      makeMessage("te/device/sensor01///m/", {
        time: "2026-02-25T10:00:00.000Z",
        temperature: 23.5,
        humidity: 60.0,
      }),
      ctx,
    );
    var data = findMsg(output, "DDATA");
    (0, globals_1.expect)(data.topic).toBe(
      "spBv1.0/my-factory/DDATA/gateway01/sensor01",
    );
    // BIRTH carries metric names so consumers can build the alias map
    var birth = (0, protobuf_1.fromBinary)(
      sparkplug_b_pb_1.PayloadSchema,
      findMsg(output, "DBIRTH").payload,
    );
    (0, globals_1.expect)(birth.metrics).toHaveLength(2);
    var names = birth.metrics.map(function (m) {
      return m.name;
    });
    (0, globals_1.expect)(names).toContain("temperature");
    (0, globals_1.expect)(names).toContain("humidity");
    // DATA carries values (via alias)
    var dataPayload = (0, protobuf_1.fromBinary)(
      sparkplug_b_pb_1.PayloadSchema,
      data.payload,
    );
    (0, globals_1.expect)(dataPayload.metrics).toHaveLength(2);
    var tempData = dataPayload.metrics.find(function (m) {
      return (
        m.alias ===
        birth.metrics.find(function (b) {
          return b.name === "temperature";
        }).alias
      );
    });
    (0, globals_1.expect)(tempData.value.case).toBe("doubleValue");
    (0, globals_1.expect)(tempData.value.value).toBeCloseTo(23.5);
  });
  (0, globals_1.test)(
    "edge node device maps to NBIRTH + NDATA topics",
    function () {
      var ctx = tedge.createContext(
        __assign(__assign({}, BASE_CONFIG), { edgeNodeId: "gateway01" }),
      );
      var output = flow.onMessage(
        makeMessage("te/device/gateway01///m/", { temperature: 22.0 }),
        ctx,
      );
      (0, globals_1.expect)(findMsg(output, "NBIRTH").topic).toBe(
        "spBv1.0/my-factory/NBIRTH/gateway01",
      );
      (0, globals_1.expect)(findMsg(output, "NDATA").topic).toBe(
        "spBv1.0/my-factory/NDATA/gateway01",
      );
    },
  );
  (0, globals_1.test)(
    "named measurement type: BIRTH carries the correct metric name",
    function () {
      var ctx = tedge.createContext(BASE_CONFIG);
      var output = flow.onMessage(
        makeMessage("te/device/plc01///m/environment", {
          time: "2026-02-25T10:00:00.000Z",
          co2: 412.0,
        }),
        ctx,
      );
      var birth = (0, protobuf_1.fromBinary)(
        sparkplug_b_pb_1.PayloadSchema,
        findMsg(output, "DBIRTH").payload,
      );
      (0, globals_1.expect)(birth.metrics[0].name).toBe("co2");
    },
  );
  (0, globals_1.test)(
    "boolean and string values are mapped to correct Sparkplug B datatypes",
    function () {
      var ctx = tedge.createContext(BASE_CONFIG);
      var output = flow.onMessage(
        makeMessage("te/device/sensor01///m/", {
          active: true,
          status: "ok",
        }),
        ctx,
      );
      var birth = (0, protobuf_1.fromBinary)(
        sparkplug_b_pb_1.PayloadSchema,
        findMsg(output, "DBIRTH").payload,
      );
      var activeB = birth.metrics.find(function (m) {
        return m.name === "active";
      });
      (0, globals_1.expect)(activeB.datatype).toBe(11); // Boolean
      (0, globals_1.expect)(activeB.value.case).toBe("booleanValue");
      var statusB = birth.metrics.find(function (m) {
        return m.name === "status";
      });
      (0, globals_1.expect)(statusB.datatype).toBe(12); // String
      (0, globals_1.expect)(statusB.value.case).toBe("stringValue");
    },
  );
  // ── Timestamps ────────────────────────────────────────────────────────────
  (0, globals_1.test)(
    "payload timestamp propagates to BIRTH and DATA",
    function () {
      var ctx = tedge.createContext(BASE_CONFIG);
      var output = flow.onMessage(
        makeMessage(
          "te/device/sensor01///m/",
          { time: "2026-01-15T08:30:00.000Z", temperature: 20.0 },
          new Date("2026-01-15T09:00:00.000Z"),
        ),
        ctx,
      );
      var expectedTs = new Date("2026-01-15T08:30:00.000Z").getTime();
      for (var _i = 0, output_1 = output; _i < output_1.length; _i++) {
        var msg = output_1[_i];
        var sp = (0, protobuf_1.fromBinary)(
          sparkplug_b_pb_1.PayloadSchema,
          msg.payload,
        );
        (0, globals_1.expect)(Number(sp.timestamp)).toBe(expectedTs);
        (0, globals_1.expect)(Number(sp.metrics[0].timestamp)).toBe(expectedTs);
      }
    },
  );
  // ── Sequence numbers ──────────────────────────────────────────────────────
  (0, globals_1.test)(
    "BIRTH gets seq=0, first DATA gets seq=1, second DATA gets seq=2",
    function () {
      var ctx = tedge.createContext(BASE_CONFIG);
      var msg = function () {
        return makeMessage("te/device/sensor01///m/", { value: 1.0 });
      };
      var first = flow.onMessage(msg(), ctx);
      var birth = (0, protobuf_1.fromBinary)(
        sparkplug_b_pb_1.PayloadSchema,
        findMsg(first, "DBIRTH").payload,
      );
      var data1 = (0, protobuf_1.fromBinary)(
        sparkplug_b_pb_1.PayloadSchema,
        findMsg(first, "DDATA").payload,
      );
      (0, globals_1.expect)(Number(birth.seq)).toBe(0);
      (0, globals_1.expect)(Number(data1.seq)).toBe(1);
      var second = flow.onMessage(msg(), ctx);
      var data2 = (0, protobuf_1.fromBinary)(
        sparkplug_b_pb_1.PayloadSchema,
        second[0].payload,
      );
      (0, globals_1.expect)(Number(data2.seq)).toBe(2);
    },
  );
  (0, globals_1.test)("sequence number wraps at 256", function () {
    var ctx = tedge.createContext(BASE_CONFIG);
    var msg = function () {
      return makeMessage("te/device/sensor01///m/", { value: 1.0 });
    };
    // First call: birth(seq=0) + data(seq=1) — consumes two sequence numbers.
    // Subsequent calls: data only (one seq each).
    // Call k (k≥2) uses seq=k, so call 255 uses seq=255 and call 256 uses seq=0.
    for (var i = 0; i < 254; i++) {
      flow.onMessage(msg(), ctx);
    }
    var at255 = flow.onMessage(msg(), ctx);
    var sp255 = (0, protobuf_1.fromBinary)(
      sparkplug_b_pb_1.PayloadSchema,
      at255[0].payload,
    );
    (0, globals_1.expect)(Number(sp255.seq)).toBe(255);
    var at0 = flow.onMessage(msg(), ctx);
    var sp0 = (0, protobuf_1.fromBinary)(
      sparkplug_b_pb_1.PayloadSchema,
      at0[0].payload,
    );
    (0, globals_1.expect)(Number(sp0.seq)).toBe(0);
  });
  // ── Edge cases ────────────────────────────────────────────────────────────
  (0, globals_1.test)("non-measurement topics are ignored", function () {
    var ctx = tedge.createContext(BASE_CONFIG);
    var output = flow.onMessage(
      { time: new Date(), topic: "te/device/sensor01///a/", payload: "{}" },
      ctx,
    );
    (0, globals_1.expect)(output).toHaveLength(0);
  });
  (0, globals_1.test)(
    "empty payload with no measurements returns no output",
    function () {
      var ctx = tedge.createContext(BASE_CONFIG);
      var output = flow.onMessage(
        makeMessage("te/device/sensor01///m/", {
          time: "2026-02-25T10:00:00.000Z",
        }),
        ctx,
      );
      (0, globals_1.expect)(output).toHaveLength(0);
    },
  );
});
