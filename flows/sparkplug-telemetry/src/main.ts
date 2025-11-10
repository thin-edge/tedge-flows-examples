import { Message, Context } from "../../common/tedge";

export async function onMessage(
  message: Message,
  _context: Context,
): Promise<Message[]> {
  const [_spec, _node, messageType, device, telemetryType] =
    message.topic.split("/");
  switch (messageType) {
    case "DDATA": {
      const payload: any = JSON.parse(
        new TextDecoder().decode(message.payload),
      );
      const series = payload?.metrics.reduce((props: any, metric: any) => {
        if (metric.type == "Float" || metric.type == "Double") {
          props[metric.name] = metric.value;
        }
        return props;
      }, {} as any);
      if (Object.keys(series).length > 0) {
        return [
          {
            topic: `te/device/${device}///m/${telemetryType}`,
            payload: new TextEncoder().encode(
              JSON.stringify({
                time: payload.timestamp / 1000,
                [telemetryType]: series,
              }),
            ),
          },
        ];
      }
      break;
    }
  }
  return [];
}
