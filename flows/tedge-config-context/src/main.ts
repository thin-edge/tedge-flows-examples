import { Message, Context } from "../../common/tedge";

const keys = ["device.id"];
const utf8 = new TextDecoder();

export function onMessage(message: Message, context: Context): Message[] {
  if (typeof message.payload === "string") {
    return [];
  }
  utf8.decode(message.payload);
  const [key, ...rest] = utf8.decode(message.payload).split("=");
  const value = rest.join("=");
  if (key && value) {
    if (keys.includes(key)) {
      console.log(`key=${key}, value=${value}`);
      context.mapper.set(`${key}`, value);
    }
  }
  return [];
}
