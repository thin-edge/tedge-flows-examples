import { expect, test } from "@jest/globals";
import * as tedge from "../../common/tedge";
import * as flow from "../src/main";

jest.useFakeTimers();

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
    expect(output).toHaveLength(2);

    expect(output[0].topic).toBe("tb/me/server/rpc/response/15");
    const payload = JSON.parse(output[0].payload);
    expect(payload).toStrictEqual({
      status: "successful",
      execute: "now",
    });

    expect(output[1].topic).toBe(
      "te/device/main///cmd/deviceRestart/tb-mapper-15",
    );
    expect(output[1].payload).toBe("");
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
    expect(output).toHaveLength(2);

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

    expect(output[1].topic).toBe(
      "te/device/child1///cmd/getValue/tb-mapper-42",
    );
    expect(output[1].payload).toBe("");
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
    expect(output).toHaveLength(2);

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

    expect(output[1].topic).toBe(
      "te/device/child1/service/app1/cmd/getValue/tb-mapper-42",
    );
    expect(output[1].payload).toBe("");
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

  test("should ignore command with intermediate state", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "te/device/main///cmd/someCommand/tb-mapper-123",
      payload: JSON.stringify({
        status: "executing",
      }),
    };
    const context = tedge.createContext({});
    const output = flow.onMessage(message, context);
    expect(output).toHaveLength(0);
  });
});
