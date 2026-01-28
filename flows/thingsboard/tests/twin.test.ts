import { expect, test } from "@jest/globals";
import * as tedge from "../../common/tedge";
import * as flow from "../src/main";

jest.useFakeTimers();

describe("Map Main Device Twin to Device Me Attributes API", () => {
  test("should remove timestamp", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "te/device/main///twin/software",
      payload: JSON.stringify({
        os: "debian",
        version: "bullseye",
        time: 1602739847.0,
      }),
    };
    const context = tedge.createContext({
      main_device_name: "PROD_GATEWAY",
      add_type_to_key: true,
    });
    const output = flow.onMessage(message, context);
    expect(output).toHaveLength(1);

    expect(output[0].topic).toBe("tb/me/attributes");

    const payload = JSON.parse(output[0].payload);
    expect(payload).toStrictEqual({
      "software::os": "debian",
      "software::version": "bullseye",
    });
  });

  test("should add type to key", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "te/device/main///twin/software",
      payload: JSON.stringify({
        os: "debian",
        version: "bullseye",
      }),
    };
    const context = tedge.createContext({
      main_device_name: "PROD_GATEWAY",
      add_type_to_key: true,
    });
    const output = flow.onMessage(message, context);
    expect(output).toHaveLength(1);

    expect(output[0].topic).toBe("tb/me/attributes");

    const payload = JSON.parse(output[0].payload);
    expect(payload).toStrictEqual({
      "software::os": "debian",
      "software::version": "bullseye",
    });
  });

  test("should not add type due to config", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "te/device/main///twin/software",
      payload: JSON.stringify({
        os: "debian",
        version: "bullseye",
      }),
    };
    const context = tedge.createContext({
      add_type_to_key: false,
    });
    const output = flow.onMessage(message, context);
    expect(output).toHaveLength(1);

    expect(output[0].topic).toBe("tb/me/attributes");

    const payload = JSON.parse(output[0].payload);
    expect(payload).toStrictEqual({
      os: "debian",
      version: "bullseye",
    });
  });

  test("Should not add type when type is missing in topic", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "te/device/main///twin/",
      payload: JSON.stringify({
        os: "debian",
        version: "bullseye",
      }),
    };
    const context = tedge.createContext();
    const output = flow.onMessage(message, context);
    expect(output).toHaveLength(1);

    expect(output[0].topic).toBe("tb/me/attributes");

    const payload = JSON.parse(output[0].payload);
    expect(payload).toStrictEqual({
      os: "debian",
      version: "bullseye",
    });
  });

  test("Should handle string payload", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "te/device/main///twin/os",
      payload: "debian",
    };
    const context = tedge.createContext();
    const output = flow.onMessage(message, context);
    expect(output).toHaveLength(1);

    expect(output[0].topic).toBe("tb/me/attributes");

    const payload = JSON.parse(output[0].payload);
    expect(payload).toStrictEqual({
      os: "debian",
    });
  });

  test("Should accept boolean payload", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "te/device/main///twin/isActive",
      payload: "true",
    };
    const context = tedge.createContext();
    const output = flow.onMessage(message, context);
    expect(output).toHaveLength(1);

    expect(output[0].topic).toBe("tb/me/attributes");

    const payload = JSON.parse(output[0].payload);
    expect(payload).toStrictEqual({
      isActive: true,
    });
  });
});

describe("Map Child/Service Device Twin to GatewayAttributes API", () => {
  test("child device", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "te/device/child1///twin/software",
      payload: JSON.stringify({
        os: "debian",
        version: "bullseye",
      }),
    };
    const context = tedge.createContext({
      add_type_to_key: false,
    });
    const output = flow.onMessage(message, context);
    expect(output).toHaveLength(1);

    expect(output[0].topic).toBe("tb/gateway/attributes");

    const payload = JSON.parse(output[0].payload);
    expect(payload).toStrictEqual({
      "MAIN:device:child1": {
        os: "debian",
        version: "bullseye",
      },
    });
  });

  test("service", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "te/device/child1/service/app1/twin/isActive",
      payload: "true",
    };
    const context = tedge.createContext();
    const output = flow.onMessage(message, context);
    expect(output).toHaveLength(1);

    expect(output[0].topic).toBe("tb/gateway/attributes");

    const payload = JSON.parse(output[0].payload);
    expect(payload).toStrictEqual({
      "MAIN:device:child1:service:app1": {
        isActive: true,
      },
    });
  });
});
