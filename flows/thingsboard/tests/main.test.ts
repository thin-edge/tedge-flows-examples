import { expect, test } from "@jest/globals";
import * as tedge from "../../common/tedge";
import * as flow from "../src/main";

jest.useFakeTimers();

describe("Map Measurements to Telemetry", () => {
  test("should add type to key", () => {
    const message: tedge.Message = {
      timestamp: tedge.mockGetTime(),
      topic: "te/device/main///m/sensor",
      payload: JSON.stringify({
        temperature: 10,
      }),
    };
    const output = flow.onMessage(message, {
      config: {
        main_device_name: "PROD_GATEWAY",
        add_type_to_key: true,
      },
    });
    expect(output).toHaveLength(1);
    const payload = JSON.parse(output[0].payload);
    expect(payload).toStrictEqual({
      PROD_GATEWAY: [
        {
          "sensor::temperature": 10,
        },
      ],
    });
  });

  test("should convert timestamp", () => {
    const message: tedge.Message = {
      timestamp: tedge.mockGetTime(),
      topic: "te/device/main///m/sensor",
      payload: JSON.stringify({
        temperature: 10,
        time: 1602739847.0,
      }),
    };
    const output = flow.onMessage(message, {
      config: {
        main_device_name: "PROD_GATEWAY",
        add_type_to_key: true,
      },
    });
    expect(output).toHaveLength(1);
    const payload = JSON.parse(output[0].payload);
    expect(payload).toStrictEqual({
      PROD_GATEWAY: [
        {
          ts: 1602739847000,
          values: {
            "sensor::temperature": 10,
          },
        },
      ],
    });
  });

  test("should not add type due to config", () => {
    const message: tedge.Message = {
      timestamp: tedge.mockGetTime(),
      topic: "te/device/child1///m/sensor",
      payload: JSON.stringify({
        temperature: 10,
      }),
    };
    const output = flow.onMessage(message, {
      config: {
        add_type_to_key: false,
      },
    });
    expect(output).toHaveLength(1);
    const payload = JSON.parse(output[0].payload);
    expect(payload).toStrictEqual({
      child1: [
        {
          temperature: 10,
        },
      ],
    });
  });

  test("Should not add type due to lacking type in topic", () => {
    const message: tedge.Message = {
      timestamp: tedge.mockGetTime(),
      topic: "te/device/child1/service/app1/m/",
      payload: JSON.stringify({
        temperature: 10,
      }),
    };
    const output = flow.onMessage(message, {
      config: {},
    });
    expect(output).toHaveLength(1);
    const payload = JSON.parse(output[0].payload);
    expect(payload).toStrictEqual({
      child1_app1: [
        {
          temperature: 10,
        },
      ],
    });
  });
});

describe("Map Twin to Attributes", () => {
  test("should remove timestamp", () => {
    const message: tedge.Message = {
      timestamp: tedge.mockGetTime(),
      topic: "te/device/main///twin/software",
      payload: JSON.stringify({
        os: "debian",
        version: "bullseye",
        time: 1602739847.0,
      }),
    };
    const output = flow.onMessage(message, {
      config: {
        main_device_name: "PROD_GATEWAY",
        add_type_to_key: true,
      },
    });
    expect(output).toHaveLength(1);
    const payload = JSON.parse(output[0].payload);
    expect(payload).toStrictEqual({
      PROD_GATEWAY: {
        "software::os": "debian",
        "software::version": "bullseye",
      },
    });
  });

  test("should add type to key", () => {
    const message: tedge.Message = {
      timestamp: tedge.mockGetTime(),
      topic: "te/device/main///twin/software",
      payload: JSON.stringify({
        os: "debian",
        version: "bullseye",
      }),
    };
    const output = flow.onMessage(message, {
      config: {
        main_device_name: "PROD_GATEWAY",
        add_type_to_key: true,
      },
    });
    expect(output).toHaveLength(1);
    const payload = JSON.parse(output[0].payload);
    expect(payload).toStrictEqual({
      PROD_GATEWAY: {
        "software::os": "debian",
        "software::version": "bullseye",
      },
    });
  });

  test("should not add type due to config", () => {
    const message: tedge.Message = {
      timestamp: tedge.mockGetTime(),
      topic: "te/device/child1///twin/software",
      payload: JSON.stringify({
        os: "debian",
        version: "bullseye",
      }),
    };
    const output = flow.onMessage(message, {
      config: {
        add_type_to_key: false,
      },
    });
    expect(output).toHaveLength(1);
    const payload = JSON.parse(output[0].payload);
    expect(payload).toStrictEqual({
      child1: {
        os: "debian",
        version: "bullseye",
      },
    });
  });

  test("Should not add type due to lacking type in topic", () => {
    const message: tedge.Message = {
      timestamp: tedge.mockGetTime(),
      topic: "te/device/child1/service/app1/twin/",
      payload: JSON.stringify({
        os: "debian",
        version: "bullseye",
      }),
    };
    const output = flow.onMessage(message);
    expect(output).toHaveLength(1);
    const payload = JSON.parse(output[0].payload);
    expect(payload).toStrictEqual({
      child1_app1: {
        os: "debian",
        version: "bullseye",
      },
    });
  });

  test("Should accept string payload", () => {
    const message: tedge.Message = {
      timestamp: tedge.mockGetTime(),
      topic: "te/device/child1/service/app1/twin/os",
      payload: "debian",
    };
    const output = flow.onMessage(message);
    expect(output).toHaveLength(1);
    const payload = JSON.parse(output[0].payload);
    expect(payload).toStrictEqual({
      child1_app1: {
        os: "debian",
      },
    });
  });

  test("Should accept boolean payload", () => {
    const message: tedge.Message = {
      timestamp: tedge.mockGetTime(),
      topic: "te/device/child1/service/app1/twin/isActive",
      payload: "true",
    };
    const output = flow.onMessage(message);
    expect(output).toHaveLength(1);
    const payload = JSON.parse(output[0].payload);
    expect(payload).toStrictEqual({
      child1_app1: {
        isActive: true,
      },
    });
  });
});

describe("thin-edge.io to ThingsBoard Device Naming", () => {
  test("should map main device to value from config", () => {
    const topic = "te/device/main///m/sensor";
    expect(flow.mapTopicToDeviceName(topic, "PROD_GATEWAY")).toBe(
      "PROD_GATEWAY",
    );
  });

  test("should map main device to default", () => {
    const topic = "te/device/main///m/sensor";
    expect(flow.mapTopicToDeviceName(topic)).toBe("MAIN");
  });

  test("should map child devices directly", () => {
    const topic = "te/device/child1///m/sensor";
    expect(flow.mapTopicToDeviceName(topic)).toBe("child1");
  });

  test("should concatenate main services correctly", () => {
    const topic = "te/device/main/service/app1/m/sensor";
    expect(flow.mapTopicToDeviceName(topic, "PROD_GATEWAY")).toBe(
      "PROD_GATEWAY_app1",
    );
  });

  test("should concatenate child services correctly", () => {
    const topic = "te/device/child1/service/app2/m/sensor";
    expect(flow.mapTopicToDeviceName(topic)).toBe("child1_app2");
  });

  test("should fallback to device ID for unknown segments", () => {
    const topic1 = "te/device/main/some/thing/m/sensor";
    const topic2 = "te/device/child1/some/thing/m/sensor";
    expect(flow.mapTopicToDeviceName(topic1)).toBe("MAIN");
    expect(flow.mapTopicToDeviceName(topic2)).toBe("child1");
  });
});
