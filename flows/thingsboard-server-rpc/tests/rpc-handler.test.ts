import { expect, test } from "@jest/globals";
import * as tedge from "../../common/tedge";
import * as flow from "../src/main";

jest.useFakeTimers();

describe("Map ThingsBoard RPC to thin-edge command", () => {
  test("params is string", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "tb/me/server/rpc/request/15",
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
      topic: "tb/me/server/rpc/request/15",
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
