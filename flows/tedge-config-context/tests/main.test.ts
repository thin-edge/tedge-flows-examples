import { expect, test, describe } from "@jest/globals";
import * as tedge from "../../common/tedge";
import * as flow from "../src/main";

describe("store tedge config in the context", () => {
  test.each([
    {
      description: "device.id should be present",
      payload: "device.id=foo",
      expectedOutputLength: 0,
      expectedKeysLength: 1,
      expectedContext: { "device.id": "foo" },
    },
    {
      description: "ignore config that doesn't match given keys",
      payload: "other=value",
      expectedOutputLength: 0,
      expectedKeysLength: 0,
      expectedContext: {},
    },
  ])(
    "$description",
    ({
      payload,
      expectedOutputLength,
      expectedKeysLength,
      expectedContext,
    }) => {
      const context = tedge.createContext({});
      const output = flow.onMessage(
        {
          time: new Date(),
          topic: "",
          payload: new TextEncoder().encode(payload),
        },
        context,
      );
      expect(output).toHaveLength(expectedOutputLength);
      expect(context.mapper.keys()).toHaveLength(expectedKeysLength);

      for (const [key, value] of Object.entries(expectedContext)) {
        expect(context.mapper.get(key)).toBe(value);
      }
    },
  );
});
