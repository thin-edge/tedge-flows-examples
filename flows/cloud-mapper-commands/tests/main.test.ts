import { expect, test, describe } from "@jest/globals";
import * as flow from "../src/main";
import {
  decodeJSON,
  decodeText,
  encodeJSON,
  encodeText,
} from "../../common/tedge";

describe("Cloud to device", () => {
  test("Ignore unknown cloud commands", () => {
    const output = flow.onMessage(
      {
        time: new Date("2025-01-01"),
        topic: "azeg/DCMD/device_child-1",
        payload: encodeJSON({
          type: "unknown-command",
        }),
      },
      { config: {} },
    );
    expect(output).toHaveLength(0);
  });

  test("Map cloud command to local tedge command", () => {
    const output = flow.onMessage(
      {
        time: new Date("2025-01-01"),
        topic: "azeg/DCMD/device_child-1",
        payload: encodeJSON({
          type: "writeSetpoint",
          parameters: {
            name: "flow.limit",
            value: 30.1,
          },
        }),
      },
      { config: {} },
    );
    expect(output).toHaveLength(1);
    expect(output[0].topic).toMatch(
      RegExp(`^te/device/child-1///cmd/writeSetpoint/azeg-[0-9]+`),
    );
    const payload = decodeJSON(output[0].payload);
    expect(payload).toStrictEqual({
      status: "init",
      type: "writeSetpoint",
      parameters: {
        name: "flow.limit",
        value: 30.1,
      },
      _azeg: {
        prefix: "azeg",
      },
    });
  });
});

describe("Device to cloud mappings", () => {
  const inputMessage = (status: string) => {
    return {
      time: new Date("2025-01-01"),
      topic: "te/device/child-1///cmd/writeSetpoint/azeg-123456",
      payload: encodeJSON({
        type: "writeSetpoint",
        status,
      }),
    };
  };

  describe.each([
    [inputMessage("successful"), 1, ""],
    [inputMessage("failed"), 1, ""],
    [inputMessage("executing"), 0, ""],
  ])(
    "Clear local command once it has completed",
    (input: any, expectedCount: number, expectedPayload: any) => {
      test("command is cleared", () => {
        const output = flow.onMessage(input, { config: {} });
        expect(output).toHaveLength(expectedCount);
        if (expectedCount > 0) {
          expect(output[0].transportFields?.retain).toBe(true);
          expect(decodeText(output[0].payload)).toBe(expectedPayload);
          expect(output[0].topic).toBe(input.topic);
        }
      });
    },
  );

  test("Clearing a local commands does not create more messages", () => {
    const output = flow.onMessage(
      {
        time: new Date("2025-01-01"),
        topic: "te/device/child-1///cmd/writeSetpoint/azeg-123456",
        transportFields: {
          retain: true,
        },
        payload: encodeText(""),
      },
      { config: {} },
    );
    expect(output).toHaveLength(0);
  });
});
