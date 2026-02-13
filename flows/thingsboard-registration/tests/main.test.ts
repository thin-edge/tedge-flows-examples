import { expect, test, describe } from "@jest/globals";
import * as tedge from "../../common/tedge";
import * as flow from "../src/main";

describe("ThingsBoard Registration Flow", () => {
  describe("Child Device Registration", () => {
    test("should register a child device and create connect/attributes messages", () => {
      const message: tedge.Message = {
        time: tedge.mockGetTime(),
        topic: "te/device/child0//",
        payload: JSON.stringify({
          "@type": "child-device",
          "@parent": "device/main//",
          name: "Child Device 0",
          type: "sensor",
        }),
      };

      const context = tedge.createContext({
        main_device_name: "MAIN",
        default_device_profile: "default",
        max_pending_messages: 100,
      });

      const result = flow.onMessage(message, context);

      expect(result).toHaveLength(2);

      // Check connect message
      expect(result[0].topic).toBe("tb/gateway/connect");
      const connectPayload = JSON.parse(result[0].payload);
      expect(connectPayload).toStrictEqual({
        device: "Child Device 0",
        type: "sensor",
      });

      // Check attributes message
      expect(result[1].topic).toBe("tb/gateway/attributes");
      const attributesPayload = JSON.parse(result[1].payload);
      expect(attributesPayload).toStrictEqual({
        "Child Device 0": {
          parent_device: "device/main//",
        },
      });

      // Check that device is registered in mapper KV store
      expect(context.mapper.get("tb-entity-to-name:device/child0//")).toBe(
        "Child Device 0",
      );
      expect(context.mapper.get("tb-name-to-entity:Child Device 0")).toBe(
        "device/child0//",
      );
    });

    test("should use default device profile when type is not provided", () => {
      const message: tedge.Message = {
        time: tedge.mockGetTime(),
        topic: "te/device/child1//",
        payload: JSON.stringify({
          "@type": "child-device",
          "@parent": "device/main//",
        }),
      };

      const context = tedge.createContext({
        main_device_name: "MAIN",
        default_device_profile: "default",
        max_pending_messages: 100,
      });

      const result = flow.onMessage(message, context);

      expect(result[0].topic).toBe("tb/gateway/connect");
      const connectPayload = JSON.parse(result[0].payload);
      expect(connectPayload.type).toBe("default");
    });

    test("should generate device name when name is not provided", () => {
      const message: tedge.Message = {
        time: tedge.mockGetTime(),
        topic: "te/device/child2//",
        payload: JSON.stringify({
          "@type": "child-device",
          "@parent": "device/main//",
        }),
      };

      const context = tedge.createContext({
        main_device_name: "MAIN",
        default_device_profile: "default",
        max_pending_messages: 100,
      });

      const result = flow.onMessage(message, context);

      expect(result[0].topic).toBe("tb/gateway/connect");
      const connectPayload = JSON.parse(result[0].payload);
      expect(connectPayload.device).toBe("MAIN:device:child2");
    });

    test("main device registration message should be just redirected to tbflow topic", () => {
      const message: tedge.Message = {
        time: tedge.mockGetTime(),
        topic: "te/device/main//",
        payload: JSON.stringify({
          "@type": "device",
          type: "main-profile",
        }),
      };

      const context = tedge.createContext({
        main_device_name: "TEST MAIN",
        default_device_profile: "default",
        max_pending_messages: 100,
      });

      const result = flow.onMessage(message, context);
      expect(result).toHaveLength(1);

      expect(result[0].topic).toBe("tbflow/device/main//");
      const connectPayload = JSON.parse(result[0].payload);
      expect(connectPayload).toStrictEqual({
        "@type": "device",
        type: "main-profile",
      });
    });
  });

  describe("Service Registration", () => {
    test("should register a service as a device", () => {
      const message: tedge.Message = {
        time: tedge.mockGetTime(),
        topic: "te/device/main/service/tedge-mapper-c8y",
        payload: JSON.stringify({
          "@type": "service",
          "@parent": "device/main//",
          name: "Tedge Mapper C8y",
          type: "service",
        }),
      };

      const context = tedge.createContext({
        main_device_name: "MAIN",
        default_device_profile: "default",
        max_pending_messages: 100,
      });

      const result = flow.onMessage(message, context);

      expect(result).toHaveLength(2);

      const connectPayload = JSON.parse(result[0].payload);
      expect(connectPayload).toStrictEqual({
        device: "Tedge Mapper C8y",
        type: "service",
      });

      expect(
        context.mapper.get(
          "tb-entity-to-name:device/main/service/tedge-mapper-c8y",
        ),
      ).toBe("Tedge Mapper C8y");
      expect(context.mapper.get("tb-name-to-entity:Tedge Mapper C8y")).toBe(
        "device/main/service/tedge-mapper-c8y",
      );
    });
  });

  describe("Pending Messages", () => {
    test("should store non-registration messages when device is not registered", () => {
      const message: tedge.Message = {
        time: tedge.mockGetTime(),
        topic: "te/device/child0///m/temperature",
        payload: JSON.stringify({ temperature: 25 }),
      };

      const context = tedge.createContext({
        main_device_name: "MAIN",
        default_device_profile: "default",
        max_pending_messages: 100,
      });

      const result = flow.onMessage(message, context);

      expect(result).toHaveLength(0);

      const pendingMessages = context.mapper.get("tb-msg:device/child0//");
      expect(pendingMessages).toHaveLength(1);
      expect(pendingMessages[0].topic).toBe(
        "tbflow/device/child0///m/temperature",
      );
      expect(pendingMessages[0].payload).toBe(
        JSON.stringify({ temperature: 25 }),
      );
    });

    test("should limit pending messages to max_pending_messages", () => {
      const context = tedge.createContext({
        main_device_name: "MAIN",
        default_device_profile: "default",
        max_pending_messages: 3,
      });

      for (let i = 0; i < 5; i++) {
        const message: tedge.Message = {
          time: tedge.mockGetTime(),
          topic: "te/device/child0///m/temperature",
          payload: JSON.stringify({ temperature: i }),
        };
        flow.onMessage(message, context);
      }

      const pendingMessages = context.mapper.get("tb-msg:device/child0//");
      expect(pendingMessages).toHaveLength(3);

      // Should keep the last 3 messages (temperature: 2, 3, 4)
      expect(JSON.parse(pendingMessages[0].payload).temperature).toBe(2);
      expect(JSON.parse(pendingMessages[1].payload).temperature).toBe(3);
      expect(JSON.parse(pendingMessages[2].payload).temperature).toBe(4);
    });

    test("should replay pending messages after registration", () => {
      const context = tedge.createContext({
        main_device_name: "MAIN",
        default_device_profile: "default",
        max_pending_messages: 100,
      });

      // First, send some non-registration messages
      for (let i = 0; i < 3; i++) {
        const message: tedge.Message = {
          time: tedge.mockGetTime(),
          topic: "te/device/child0///m/temperature",
          payload: JSON.stringify({ temperature: i }),
        };
        flow.onMessage(message, context);
      }

      // Now send registration message
      const registrationMessage: tedge.Message = {
        time: tedge.mockGetTime(),
        topic: "te/device/child0//",
        payload: JSON.stringify({
          "@type": "child-device",
          name: "Child Device 0",
        }),
      };

      const result = flow.onMessage(registrationMessage, context);

      // Should have: connect + attributes + 3 pending messages = 5
      expect(result.length).toBeGreaterThanOrEqual(5);

      // Check that pending messages are included
      const temperatureMessages = result.filter((m) =>
        m.topic.includes("/m/temperature"),
      );
      expect(temperatureMessages).toHaveLength(3);

      // Pending messages should be cleared
      expect(context.mapper.get("tb-msg:device/child0//")).toStrictEqual([]);
    });

    test("should store multiple types of pending messages", () => {
      const context = tedge.createContext({
        main_device_name: "MAIN",
        default_device_profile: "default",
        max_pending_messages: 100,
      });

      // Send measurement message
      const measurementMessage: tedge.Message = {
        time: tedge.mockGetTime(),
        topic: "te/device/child0///m/temperature",
        payload: JSON.stringify({ temperature: 25 }),
      };
      flow.onMessage(measurementMessage, context);

      // Send event message
      const eventMessage: tedge.Message = {
        time: tedge.mockGetTime(),
        topic: "te/device/child0///e/button_pressed",
        payload: JSON.stringify({ text: "Button was pressed" }),
      };
      flow.onMessage(eventMessage, context);

      // Send alarm message
      const alarmMessage: tedge.Message = {
        time: tedge.mockGetTime(),
        topic: "te/device/child0///a/high_temperature",
        payload: JSON.stringify({
          text: "Temperature too high",
          severity: "critical",
        }),
      };
      flow.onMessage(alarmMessage, context);

      const pendingMessages = context.mapper.get("tb-msg:device/child0//");
      expect(pendingMessages).toHaveLength(3);
      expect(pendingMessages[0].topic).toBe(
        "tbflow/device/child0///m/temperature",
      );
      expect(pendingMessages[1].topic).toBe(
        "tbflow/device/child0///e/button_pressed",
      );
      expect(pendingMessages[2].topic).toBe(
        "tbflow/device/child0///a/high_temperature",
      );
    });
  });

  describe("Registered Device Messages", () => {
    test("should forward messages with tbflow prefix for registered devices", () => {
      const context = tedge.createContext({
        main_device_name: "MAIN",
        default_device_profile: "default",
        max_pending_messages: 100,
      });

      // First register the device
      const registrationMessage: tedge.Message = {
        time: tedge.mockGetTime(),
        topic: "te/device/child0//",
        payload: JSON.stringify({
          "@type": "child-device",
          name: "Child Device 0",
        }),
      };
      flow.onMessage(registrationMessage, context);

      // Now send a measurement message
      const measurementMessage: tedge.Message = {
        time: tedge.mockGetTime(),
        topic: "te/device/child0///m/temperature",
        payload: JSON.stringify({ temperature: 25 }),
      };

      const result = flow.onMessage(measurementMessage, context);

      expect(result).toHaveLength(1);
      expect(result[0].topic).toBe("tbflow/device/child0///m/temperature");
      expect(result[0].payload).toBe(JSON.stringify({ temperature: 25 }));
    });

    test("should forward event messages for registered devices", () => {
      const context = tedge.createContext({
        main_device_name: "MAIN",
        default_device_profile: "default",
        max_pending_messages: 100,
      });

      // Register the device
      const registrationMessage: tedge.Message = {
        time: tedge.mockGetTime(),
        topic: "te/device/child0//",
        payload: JSON.stringify({
          "@type": "child-device",
          name: "Child Device 0",
        }),
      };
      flow.onMessage(registrationMessage, context);

      // Send event message
      const eventMessage: tedge.Message = {
        time: tedge.mockGetTime(),
        topic: "te/device/child0///e/button_pressed",
        payload: JSON.stringify({ text: "Button was pressed" }),
      };

      const result = flow.onMessage(eventMessage, context);

      expect(result).toHaveLength(1);
      expect(result[0].topic).toBe("tbflow/device/child0///e/button_pressed");
    });
  });

  describe("Topic Prefix Conversion", () => {
    test("should replace te/ with tbflow/ in pending message topics", () => {
      const context = tedge.createContext({
        main_device_name: "MAIN",
        default_device_profile: "default",
        max_pending_messages: 100,
      });

      const message: tedge.Message = {
        time: tedge.mockGetTime(),
        topic: "te/device/child0///e/event1",
        payload: JSON.stringify({ event: "test" }),
      };

      flow.onMessage(message, context);

      const pendingMessages = context.mapper.get("tb-msg:device/child0//");
      expect(pendingMessages[0].topic).toBe("tbflow/device/child0///e/event1");
    });

    test("should replace te/ with tbflow/ in forwarded messages", () => {
      const context = tedge.createContext({
        main_device_name: "MAIN",
        default_device_profile: "default",
        max_pending_messages: 100,
      });

      // Register device first
      const registrationMessage: tedge.Message = {
        time: tedge.mockGetTime(),
        topic: "te/device/child0//",
        payload: JSON.stringify({
          "@type": "child-device",
        }),
      };
      flow.onMessage(registrationMessage, context);

      // Send measurement
      const message: tedge.Message = {
        time: tedge.mockGetTime(),
        topic: "te/device/child0///m/humidity",
        payload: JSON.stringify({ humidity: 60 }),
      };

      const result = flow.onMessage(message, context);
      expect(result[0].topic).toBe("tbflow/device/child0///m/humidity");
    });

    test("should replace te/ with tbflow/ in forwarded messages", () => {
      const context = tedge.createContext({
        main_device_name: "MAIN",
        default_device_profile: "default",
        max_pending_messages: 100,
      });

      // Register device first
      const registrationMessage: tedge.Message = {
        time: tedge.mockGetTime(),
        topic: "te/device/child0//",
        payload: JSON.stringify({
          "@type": "child-device",
        }),
      };
      flow.onMessage(registrationMessage, context);

      // Send measurement
      const message: tedge.Message = {
        time: tedge.mockGetTime(),
        topic: "te/device/child0///m/humidity",
        payload: JSON.stringify({ humidity: 60 }),
      };

      const result = flow.onMessage(message, context);
      expect(result[0].topic).toBe("tbflow/device/child0///m/humidity");
    });
  });

  describe("Edge Cases", () => {
    test("main device should be added to the KV store", () => {
      const context = tedge.createContext({
        main_device_name: "MAIN DEVICE",
        default_device_profile: "default",
        max_pending_messages: 100,
      });

      expect(context.mapper.get("tb-entity-to-name:device/main//")).toBe(
        undefined,
      );
      expect(context.mapper.get("tb-name-to-entity:MAIN DEVICE")).toBe(
        undefined,
      );

      const message: tedge.Message = {
        time: tedge.mockGetTime(),
        topic: "te/device/child0//",
        payload: JSON.stringify({}),
      };

      flow.onMessage(message, context);
      expect(context.mapper.get("tb-entity-to-name:device/main//")).toBe(
        "MAIN DEVICE",
      );
      expect(context.mapper.get("tb-name-to-entity:MAIN DEVICE")).toBe(
        "device/main//",
      );
    });

    test("should handle empty payload gracefully", () => {
      const context = tedge.createContext({
        main_device_name: "MAIN",
        default_device_profile: "default",
        max_pending_messages: 100,
      });

      const message: tedge.Message = {
        time: tedge.mockGetTime(),
        topic: "te/device/child0//",
        payload: JSON.stringify({}),
      };

      const result = flow.onMessage(message, context);

      // Should return empty array for unknown/missing @type
      expect(result).toHaveLength(0);
    });

    test("should handle unknown @type in registration", () => {
      const context = tedge.createContext({
        main_device_name: "MAIN",
        default_device_profile: "default",
        max_pending_messages: 100,
      });

      const message: tedge.Message = {
        time: tedge.mockGetTime(),
        topic: "te/device/child0//",
        payload: JSON.stringify({
          "@type": "unknown-type",
        }),
      };

      const result = flow.onMessage(message, context);

      // Should return empty array for unknown types
      expect(result).toHaveLength(0);
    });

    test("should handle missing @parent in child device", () => {
      const context = tedge.createContext({
        main_device_name: "MAIN",
        default_device_profile: "default",
        max_pending_messages: 100,
      });

      const message: tedge.Message = {
        time: tedge.mockGetTime(),
        topic: "te/device/child0//",
        payload: JSON.stringify({
          "@type": "child-device",
        }),
      };

      const result = flow.onMessage(message, context);

      expect(result).toHaveLength(2);
      const attributesPayload = JSON.parse(result[1].payload);
      expect(attributesPayload["MAIN:device:child0"].parent_device).toBe(
        "unknown_parent",
      );
    });
  });

  describe("Payload Parsing non JSON case", () => {
    test("should handle empty payload (retained message cleared)", () => {
      const context = tedge.createContext({
        main_device_name: "MAIN",
        default_device_profile: "default",
        max_pending_messages: 100,
      });

      const message: tedge.Message = {
        time: tedge.mockGetTime(),
        topic: "te/device/child0///m/temperature",
        payload: "",
      };

      const result = flow.onMessage(message, context);

      // Should store as pending message with empty object
      expect(result).toHaveLength(0);
      const pendingMessages = context.mapper.get("tb-msg:device/child0//");
      expect(pendingMessages).toHaveLength(1);
      expect(pendingMessages[0].payload).toBe("");
    });

    test("should handle health status with payload 0 (down)", () => {
      const context = tedge.createContext({
        main_device_name: "MAIN",
        default_device_profile: "default",
        max_pending_messages: 100,
      });

      const message: tedge.Message = {
        time: tedge.mockGetTime(),
        topic: "te/device/main/service/my-service/status/health",
        payload: "0",
      };

      flow.onMessage(message, context);

      // Should store as pending message with health status
      const pendingMessages = context.mapper.get(
        "tb-msg:device/main/service/my-service",
      );
      expect(pendingMessages).toHaveLength(1);
      const healthPayload = pendingMessages[0].payload;
      expect(healthPayload).toBe("0");
    });

    test("should handle health status with payload 0 (down)", () => {
      const context = tedge.createContext({
        main_device_name: "MAIN",
        default_device_profile: "default",
        max_pending_messages: 100,
      });

      const message: tedge.Message = {
        time: tedge.mockGetTime(),
        topic: "te/device/main/service/my-service/status/health",
        payload: "0",
      };

      flow.onMessage(message, context);

      const pendingMessages = context.mapper.get(
        "tb-msg:device/main/service/my-service",
      );
      expect(pendingMessages).toHaveLength(1);
      const healthPayload = pendingMessages[0].payload;
      expect(healthPayload).toBe("0");
    });

    test("should handle health status with JSON payload", () => {
      const context = tedge.createContext({
        main_device_name: "MAIN",
        default_device_profile: "default",
        max_pending_messages: 100,
      });

      const message: tedge.Message = {
        time: tedge.mockGetTime(),
        topic: "te/device/main/service/my-service/status/health",
        payload: JSON.stringify({ status: "up", uptime: 1000 }),
      };

      flow.onMessage(message, context);

      const pendingMessages = context.mapper.get(
        "tb-msg:device/main/service/my-service",
      );
      expect(pendingMessages).toHaveLength(1);
      const healthPayload = JSON.parse(pendingMessages[0].payload);
      expect(healthPayload).toStrictEqual({ status: "up", uptime: 1000 });
    });

    test("should handle whitespace in payload", () => {
      const context = tedge.createContext({
        main_device_name: "MAIN",
        default_device_profile: "default",
        max_pending_messages: 100,
      });

      const message: tedge.Message = {
        time: tedge.mockGetTime(),
        topic: "te/device/child0///m/temperature",
        payload: '  { "temperature": 25 }  ',
      };

      flow.onMessage(message, context);

      const pendingMessages = context.mapper.get("tb-msg:device/child0//");
      expect(pendingMessages).toHaveLength(1);
      const payload = JSON.parse(pendingMessages[0].payload);
      expect(payload).toStrictEqual({ temperature: 25 });
    });

    test("should handle invalid JSON payload gracefully", () => {
      const context = tedge.createContext({
        main_device_name: "MAIN",
        default_device_profile: "default",
        max_pending_messages: 100,
      });

      const message: tedge.Message = {
        time: tedge.mockGetTime(),
        topic: "te/device/child0///m/temperature",
        payload: "{ invalid json }",
      };

      flow.onMessage(message, context);

      // Should not store invalid JSON as pending message
      const pendingMessages = context.mapper.get("tb-msg:device/child0//");
      expect(pendingMessages).toBeUndefined();
    });
  });
});
