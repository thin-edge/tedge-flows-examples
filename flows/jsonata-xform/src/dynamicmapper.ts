import { decodeJsonPayload, Message } from "../../common/tedge";
import jsonata from "jsonata";
import { set, get, merge, unset, has } from "es-toolkit/compat";
// https://nearform.com/insights/the-jsonata-performance-dilemma/

export interface Substitution {
  pathSource: string;
  pathTarget: string;
  repairStrategy?: string;
  expandArray?: boolean;
}

export interface DynamicMappingRule {
  id?: string;
  identifier?: string;
  name?: string;
  mappingTopic?: string;
  direction?: string;
  mappingTopicSample?: string;
  targetAPI?: string;
  targetTopic?: string;
  substitutions: Substitution[];
}

enum Mode {
  IfNotPresent = "if-not-present",
  IfDefined = "if-defined",
  Delete = "delete",
}

export interface PropertyMapping {
  source: string;
  destination: string;
  mode: Mode;
}

function applyModifiers(src: any, dst: any, paths: PropertyMapping[]): any {
  let output = {
    ...src,
  };
  paths.forEach((path) => {
    const value = get(src, path.source);
    applyModifier(value, output, path);
  });
  return output;
}

function applyModifier(value: object, output: any, path: PropertyMapping): any {
  if (path.mode == Mode.IfNotPresent) {
    if (!has(output, path.destination)) {
      set(output, path.destination, value);
    }
  } else if (path.mode == Mode.IfDefined) {
    if (typeof value !== "undefined") {
      set(output, path.destination, value);
    }
  } else if (path.mode == Mode.Delete) {
    unset(output, path.source);
  } else {
    set(output, path.destination, value);
  }
  return output;
}

export async function evaluate(
  input_message: any,
  expr: string,
  topicSegments: string[],
): Promise<any> {
  const exprN = expr.replaceAll("_TOPIC_LEVEL_", "$_TOPIC_LEVEL_");
  const expression = jsonata(exprN);
  const value = await expression.evaluate(input_message, {
    _TOPIC_LEVEL_: topicSegments,
  });
  return value;
}

export async function build(
  message: Message,
  rule: DynamicMappingRule,
): Promise<any> {
  const input_message = decodeJsonPayload(message.payload);
  const topicSegments = message.topic.split("/");
  const postModifiers: PropertyMapping[] = [];
  const mods = await Promise.all(
    rule.substitutions.map(async (sub) => {
      postModifiers.push({
        source: sub.pathSource,
        destination: sub.pathTarget,
        mode: Mode.Delete,
      });

      // Ignore target path as it should just be deleted
      if (!sub.pathTarget) {
        return {};
      }

      const value = await evaluate(
        input_message,
        sub.pathSource,
        topicSegments,
      );
      return applyModifier(
        value,
        {},
        {
          destination: sub.pathTarget,
          source: sub.pathSource,
          mode: Mode.IfDefined,
        },
      );
    }),
  );

  let output = {
    ...input_message,
  };

  mods.forEach((item) => {
    output = merge(output, item);
  });

  const finalOutput = applyModifiers(output, {}, postModifiers);
  // TODO: should the _TOPIC mapping be part of the rule modifiers?
  // or treated independently
  // evaluate(finalOutput, rule.mappingTopic, topicSegments);
  return finalOutput;
}
