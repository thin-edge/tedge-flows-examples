import { expect, test } from "@jest/globals";
import * as tedge from "../../common/tedge";
import * as flow from "../src/main";

jest.useFakeTimers();

describe("onInterval - Send Heartbeat and Health Status", () => {
  let context: flow.FlowContext;

  beforeEach(() => {
    context = tedge.createContext({
      enable_heartbeat: true,
    }) as flow.FlowContext;

    // Setup mapper KV store with device names
    context.mapper.set("tb-entity-to-name:device/main//", "PROD_GATEWAY");
    context.mapper.set(
      "tb-entity-to-name:device/main/service/c8y-firmware-plugin",
      "C8Y_FIRMWARE_PLUGIN",
    );
    context.mapper.set(
      "tb-entity-to-name:device/main/service/mosquitto",
      "MOSQUITTO_SERVICE",
    );
    context.mapper.set(
      "tb-entity-to-name:device/sensor-001/service/telemetry",
      "SENSOR_TELEMETRY",
    );
  });

  test("should return empty array when heartbeat is disabled", () => {
    const contextDisabled = tedge.createContext({
      enable_heartbeat: false,
    }) as flow.FlowContext;

    const output = flow.onInterval(new Date(), contextDisabled);

    expect(output).toEqual([]);
  });

  test("should send main device heartbeat when no health statuses exist", () => {
    const output = flow.onInterval(new Date(), context);

    expect(output).toHaveLength(1);
    expect(output[0].topic).toBe("tb/me/telemetry");
    expect(JSON.parse(output[0].payload)).toEqual({ heartbeat: 1 });
  });

  test("should send health status telemetry for each entity with health status", () => {
    // Add health statuses to script KV store
    context.script.set(
      "tb-health:device/main/service/c8y-firmware-plugin",
      "up",
    );
    context.script.set("tb-health:device/main/service/mosquitto", "degraded");
    context.script.set("tb-health:device/sensor-001/service/telemetry", "down");

    const output = flow.onInterval(new Date(), context);

    // Should have 3 health status messages + 1 main device heartbeat
    expect(output).toHaveLength(4);

    // Check main device service health
    const firmwareMsg = output.find((msg) => {
      const payload = JSON.parse(msg.payload);
      return payload.C8Y_FIRMWARE_PLUGIN !== undefined;
    });
    expect(firmwareMsg).toBeDefined();
    expect(firmwareMsg!.topic).toBe("tb/gateway/telemetry");
    expect(JSON.parse(firmwareMsg!.payload)).toEqual({
      C8Y_FIRMWARE_PLUGIN: [{ "health::status": "up" }],
    });

    // Check another service health
    const mosquittoMsg = output.find((msg) => {
      const payload = JSON.parse(msg.payload);
      return payload.MOSQUITTO_SERVICE !== undefined;
    });
    expect(mosquittoMsg).toBeDefined();
    expect(mosquittoMsg!.topic).toBe("tb/gateway/telemetry");
    expect(JSON.parse(mosquittoMsg!.payload)).toEqual({
      MOSQUITTO_SERVICE: [{ "health::status": "degraded" }],
    });

    // Check child device service health
    const sensorMsg = output.find((msg) => {
      const payload = JSON.parse(msg.payload);
      return payload.SENSOR_TELEMETRY !== undefined;
    });
    expect(sensorMsg).toBeDefined();
    expect(sensorMsg!.topic).toBe("tb/gateway/telemetry");
    expect(JSON.parse(sensorMsg!.payload)).toEqual({
      SENSOR_TELEMETRY: [{ "health::status": "down" }],
    });

    // Check main device heartbeat is still sent
    const heartbeatMsg = output.find((msg) => {
      const payload = JSON.parse(msg.payload);
      return payload.heartbeat !== undefined;
    });
    expect(heartbeatMsg).toBeDefined();
    expect(JSON.parse(heartbeatMsg!.payload)).toEqual({ heartbeat: 1 });
  });

  test("should set correct isMain flag for main device vs child devices", () => {
    // Only "device/main//" exactly triggers isMain=true
    context.script.set("tb-health:device/main//", "up");
    context.script.set("tb-health:device/sensor-001/service/telemetry", "up");

    const output = flow.onInterval(new Date(), context);

    // Main device (device/main//) message should use tb/me/telemetry (isMain=true)
    const mainDeviceMsg = output.find((msg) => {
      const payload = JSON.parse(msg.payload);
      return payload["health::status"] !== undefined;
    });
    expect(mainDeviceMsg?.topic).toBe("tb/me/telemetry");
    expect(JSON.parse(mainDeviceMsg!.payload)).toEqual({
      "health::status": "up",
    });

    // Child device message should use tb/gateway/telemetry (isMain=false)
    const childDeviceMsg = output.find((msg) => {
      const payload = JSON.parse(msg.payload);
      return payload.SENSOR_TELEMETRY !== undefined;
    });
    expect(childDeviceMsg?.topic).toBe("tb/gateway/telemetry");
  });

  test("should include time in all messages", () => {
    context.script.set(
      "tb-health:device/main/service/c8y-firmware-plugin",
      "up",
    );

    const output = flow.onInterval(new Date(), context);

    output.forEach((message) => {
      expect(message.time).toBeInstanceOf(Date);
      expect(message.time.getTime()).toBeDefined();
    });
  });

  test("should handle multiple health statuses correctly", () => {
    context.script.set(
      "tb-health:device/main/service/c8y-firmware-plugin",
      "up",
    );
    context.script.set("tb-health:device/main/service/mosquitto", "up");
    context.script.set(
      "tb-health:device/sensor-001/service/telemetry",
      "degraded",
    );

    const output = flow.onInterval(new Date(), context);

    // 3 health statuses + 1 main heartbeat
    expect(output).toHaveLength(4);

    // All should have valid payloads
    output.forEach((msg) => {
      const payload = JSON.parse(msg.payload);
      expect(payload).toBeDefined();
      expect(payload).not.toEqual({});
    });
  });

  test("should ignore keys that don't have the health prefix", () => {
    context.script.set(
      "tb-health:device/main/service/c8y-firmware-plugin",
      "up",
    );
    context.script.set("other-key", "some-value");
    context.script.set("random-data:device/main", "data");

    const output = flow.onInterval(new Date(), context);

    // Only 1 health status + 1 main heartbeat (other keys ignored)
    expect(output).toHaveLength(2);
  });

  test("should send correct payload structure for health status", () => {
    // Use device/main// to trigger isMain=true
    context.script.set("tb-health:device/main//", "up");

    const output = flow.onInterval(new Date(), context);

    const healthMsg = output.find((msg) => {
      const payload = JSON.parse(msg.payload);
      return payload["health::status"] !== undefined;
    });
    expect(healthMsg).toBeDefined();
    expect(JSON.parse(healthMsg!.payload)).toEqual({ "health::status": "up" });
  });

  test("should send correct payload structure for heartbeat", () => {
    const output = flow.onInterval(new Date(), context);

    const heartbeatMsg = output.find((msg) => {
      const payload = JSON.parse(msg.payload);
      return payload.heartbeat !== undefined;
    });
    expect(heartbeatMsg).toBeDefined();
    expect(JSON.parse(heartbeatMsg!.payload)).toEqual({ heartbeat: 1 });
  });

  test("should handle missing device names in mapper gracefully", () => {
    context.script.set(
      "tb-health:device/unknown/service/unknown-service",
      "up",
    );

    // Should not throw, just handle gracefully
    const output = flow.onInterval(new Date(), context);

    expect(output).toBeDefined();
    expect(Array.isArray(output)).toBe(true);
  });
});
