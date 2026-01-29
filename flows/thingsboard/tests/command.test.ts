import { expect, test } from "@jest/globals";
import * as tedge from "../../common/tedge";
import * as flow from "../src/main";

jest.useFakeTimers();

describe("Map ThingsBoard RPC to thin-edge command", () => {
  test("params is string", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "tb/me/rpc/request/15",
      payload: JSON.stringify({
        method: "myMethod",
        params: "do",
      }),
    };
    const context = tedge.createContext({
      main_device_name: "MAIN",
    });
    const output = flow.onMessage(message, context);
    expect(output).toHaveLength(1);

    expect(output[0].topic).toBe("te/device/main///cmd/myMethod/tb-mapper-15");

    const payload = JSON.parse(output[0].payload);
    expect(payload).toStrictEqual({
      status: "init",
      value: "do",
    });
  });

  test("params is object", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "tb/me/rpc/request/15",
      payload: JSON.stringify({
        method: "myMethod",
        params: {
          key: "control1",
          value: "on",
        },
      }),
    };
    const context = tedge.createContext({
      main_device_name: "MAIN",
    });
    const output = flow.onMessage(message, context);
    expect(output).toHaveLength(1);

    expect(output[0].topic).toBe("te/device/main///cmd/myMethod/tb-mapper-15");

    const payload = JSON.parse(output[0].payload);
    expect(payload).toStrictEqual({
      status: "init",
      key: "control1",
      value: "on",
    });
  });

  test("child device", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "tb/gateway/rpc",
      payload: JSON.stringify({
        device: "MAIN:device:child1",
        data: { id: 0, method: "myRemoteMethod1", params: "myText" },
      }),
    };
    const context = tedge.createContext({
      main_device_name: "MAIN",
    });
    const output = flow.onMessage(message, context);
    expect(output).toHaveLength(1);

    expect(output[0].topic).toBe(
      "te/device/child1///cmd/myRemoteMethod1/tb-mapper-0",
    );

    const payload = JSON.parse(output[0].payload);
    expect(payload).toStrictEqual({
      value: "myText",
      status: "init",
    });
  });

  test("service", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "tb/gateway/rpc",
      payload: JSON.stringify({
        device: "child1:device:child11:service:app1",
        data: { id: 0, method: "myRemoteMethod1", params: "myText" },
      }),
    };
    const context = tedge.createContext({
      main_device_name: "MAIN",
    });
    const output = flow.onMessage(message, context);
    expect(output).toHaveLength(1);

    expect(output[0].topic).toBe(
      "te/device/child11/service/app1/cmd/myRemoteMethod1/tb-mapper-0",
    );

    const payload = JSON.parse(output[0].payload);
    expect(payload).toStrictEqual({
      value: "myText",
      status: "init",
    });
  });

  test("should ignore response rpc for child device", () => {
    // "id" is at the top level for response, whilst it is inside "data" nest for request.
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "tb/gateway/rpc",
      payload: JSON.stringify({
        device: "MAIN:device:child1",
        id: 0,
        data: { method: "myRemoteMethod1", params: "myText" },
      }),
    };
    const context = tedge.createContext({
      main_device_name: "MAIN",
    });
    const output = flow.onMessage(message, context);
    expect(output).toHaveLength(0);
  });
});

describe("Map thin-edge command to ThingsBoard RPC responses", () => {
  test("main device", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "te/device/main///cmd/deviceRestart/tb-mapper-15",
      payload: JSON.stringify({
        status: "successful",
        execute: "now",
      }),
    };
    const context = tedge.createContext({
      main_device_name: "MAIN",
    });
    const output = flow.onMessage(message, context);
    expect(output).toHaveLength(1);

    expect(output[0].topic).toBe("tb/me/rpc/response/15");

    const payload = JSON.parse(output[0].payload);
    expect(payload).toStrictEqual({
      status: "successful",
      execute: "now",
    });
  });

  test("child device", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "te/device/child1///cmd/getValue/tb-mapper-42",
      payload: JSON.stringify({
        status: "successful",
        result: {
          temperature: 25,
        },
      }),
    };
    const context = tedge.createContext({
      main_device_name: "MAIN",
    });
    const output = flow.onMessage(message, context);
    expect(output).toHaveLength(1);

    expect(output[0].topic).toBe("tb/gateway/rpc");

    const payload = JSON.parse(output[0].payload);
    expect(payload).toStrictEqual({
      device: "MAIN:device:child1",
      id: 42,
      data: {
        status: "successful",
        result: {
          temperature: 25,
        },
      },
    });
  });

  test("service", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "te/device/child1/service/app1/cmd/getValue/tb-mapper-42",
      payload: JSON.stringify({
        status: "successful",
        result: {
          temperature: 25,
        },
      }),
    };
    const context = tedge.createContext({
      main_device_name: "MAIN",
    });
    const output = flow.onMessage(message, context);
    expect(output).toHaveLength(1);

    expect(output[0].topic).toBe("tb/gateway/rpc");

    const payload = JSON.parse(output[0].payload);
    expect(payload).toStrictEqual({
      device: "MAIN:device:child1:service:app1",
      id: 42,
      data: {
        status: "successful",
        result: {
          temperature: 25,
        },
      },
    });
  });

  test("should ignore command responses if it is not from ThingsBoard", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "te/device/main///cmd/someCommand/other-source-123",
      payload: JSON.stringify({
        status: "successful",
      }),
    };
    const context = tedge.createContext({});
    const output = flow.onMessage(message, context);
    expect(output).toHaveLength(0);
  });

  test("should ignore command if the state is init", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "te/device/main///cmd/someCommand/tb-mapper-123",
      payload: JSON.stringify({
        status: "init",
      }),
    };
    const context = tedge.createContext({});
    const output = flow.onMessage(message, context);
    expect(output).toHaveLength(0);
  });
});
