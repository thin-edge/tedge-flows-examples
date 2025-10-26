import { expect, test, describe } from "@jest/globals";
import * as tedge from "../../common/tedge";
import * as flow from "../src/main";

describe("Cloud to device", () => {
  test("Ignore unknown cloud commands", () => {
    const output = flow.onMessage({
      timestamp: tedge.mockGetTime(new Date("2025-01-01").getTime()),
      topic: "azeg/DCMD/device_child-1",
      payload: JSON.stringify({
        type: "unknown-command",
      }),
    });
    expect(output).toHaveLength(0);
  });

  test("Map cloud command to local tedge command", () => {
    const output = flow.onMessage({
      timestamp: tedge.mockGetTime(new Date("2025-01-01").getTime()),
      topic: "azeg/DCMD/device_child-1",
      payload: JSON.stringify({
        type: "writeSetpoint",
        parameters: {
          name: "flow.limit",
          value: 30.1,
        },
      }),
    });
    expect(output).toHaveLength(1);
    expect(output[0].topic).toMatch(
      RegExp(`^te/device/child-1///cmd/writeSetpoint/azeg-[0-9]+`),
    );
    const payload = JSON.parse(output[0].payload);
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
      timestamp: tedge.mockGetTime(new Date("2025-01-01").getTime()),
      topic: "te/device/child-1///cmd/writeSetpoint/azeg-123456",
      payload: JSON.stringify({
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
        const output = flow.onMessage(input);
        expect(output).toHaveLength(expectedCount);
        if (expectedCount > 0) {
          expect(output[0].retained).toBe(true);
          expect(output[0].payload).toBe(expectedPayload);
          expect(output[0].topic).toBe(input.topic);
        }
      });
    },
  );

  test("Clearing a local commands does not create more messages", () => {
    const output = flow.onMessage({
      timestamp: tedge.mockGetTime(new Date("2025-01-01").getTime()),
      topic: "te/device/child-1///cmd/writeSetpoint/azeg-123456",
      retain: true,
      payload: "",
    });
    expect(output).toHaveLength(0);
  });
});
