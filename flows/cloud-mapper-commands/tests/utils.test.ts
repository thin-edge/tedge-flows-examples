import { expect, test, describe } from "@jest/globals";
import * as utils from "../src/utils";

describe.each([
  ["azeg/DCMD/device_child-1/foo", "te/device/child-1//"],
  ["azeg/DCMD/device_child-2", "te/device/child-2//"],
  ["azeg/DCMD/child-2", undefined],
])(
  "getDeviceUUID extracts the UUID of the device from the cloud topic",
  (topic: string, expected?: string) => {
    test("matches UUID", () => {
      const value = utils.getTedgeTopicID(topic);
      expect(value).toBe(expected);
    });
  },
);
