/*
  Calculate the total of the input values
*/
import { Message } from "../../common/tedge";
import {
  build,
  Substitution,
  DynamicMappingRule,
  evaluate,
} from "./dynamicmapper";
import { unset } from "es-toolkit/compat";

export interface Config {
  targetTopic?: string;
  targetAPI?: string;
  substitutions?: Substitution[];
}

function buildTopic(externalID: string, ...paths: string[]): string {
  return ["te", "device", externalID, "", "", ...paths].join("/");
}

export async function onMessage(message: Message, config: Config = {}) {
  const rule: DynamicMappingRule = {
    targetTopic: config.targetTopic,
    targetAPI: config.targetAPI,
    substitutions: config.substitutions || [],
  };
  const output = await build(message, rule);

  // const topic = externalID || "unknown";
  let topic = "unknown";

  if (rule.targetTopic) {
    topic = await evaluate(
      message.payload,
      rule.targetTopic,
      message.topic.split("/"),
    );
  } else {
    switch (rule.targetAPI) {
      case "MEASUREMENT": {
        const externalID = output?._IDENTITY_?.externalId;
        topic = buildTopic(externalID, "m", output?.type || "");
        unset(output, "_IDENTITY_");
        break;
      }

      case "EVENT": {
        const externalID = output?._IDENTITY_?.externalId;
        topic = buildTopic(externalID, "e", output?.type || "");
        unset(output, "_IDENTITY_");
        break;
      }
      case "ALARM": {
        const externalID = output?._IDENTITY_?.externalId;
        topic = buildTopic(externalID, "a", output?.type || "");
        unset(output, "_IDENTITY_");
        break;
      }
      case "INVENTORY": {
        const externalID = output?._IDENTITY_?.externalId;
        topic = buildTopic(externalID, "twin", output?.type || "");
        unset(output, "_IDENTITY_");
        break;
      }
    }
  }

  return {
    topic,
    payload: JSON.stringify(output),
  };
}
