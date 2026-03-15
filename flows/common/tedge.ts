export interface Flow {
  onMessage(message: Message, context: Context): Message[];
  onInterval?: (time: Date, context: Context) => Message[];
}

interface StateInterface {
  get(key: string): any;
  set(key: string, value: any): void;
  keys(): string[];
}

export interface ContextInterface {
  config: any;

  // context
  script: StateInterface;
  mapper: StateInterface;
  flow: StateInterface;
}

class ContextObject {
  _state: any = {};
  public get(key: string): any {
    return this._state[key];
  }
  public set(key: string, value: any): void {
    return (this._state[key] = value);
  }
  public keys(): string[] {
    return Object.keys(this._state);
  }
}

export class Context implements ContextInterface {
  config: any;
  mapper: StateInterface = new ContextObject();
  script: StateInterface = new ContextObject();
  flow: StateInterface = new ContextObject();

  constructor(config: any = {}) {
    this.config = config;
  }
}

export interface Message {
  time: Date;
  topic: string;
  payload: Uint8Array<ArrayBufferLike> | string;
  mqtt?: MqttInfo;
}

type MqttInfo = {
  qos?: 0 | 1 | 2;
  retain?: boolean;
};

export function createContext(config: any = {}): Context {
  return new Context(config);
}

export function mockGetTime(time: Date = new Date()): Date {
  return time;
}

export function Run(
  module: Flow,
  messages: Message[],
  context: Context = <Context>{ config: {} },
): Message[] {
  const outputMessages: Message[] = [];
  messages.forEach((message) => {
    message.time = new Date();
    const output = module.onMessage(message, context);
    outputMessages.push(...output);
    if (output.length > 0) {
      console.log(JSON.stringify(output));
    }
  });

  if (module.onInterval) {
    const output = module.onInterval(new Date(), context);
    outputMessages.push(...output);
    console.log(JSON.stringify(output));
  }
  return outputMessages;
}

// Check if the topic references the main device
export function isMainDevice(topic: string): boolean {
  return !!topic.match(/^.+\/device\/main\/.*\/.*\//);
}

export function encodePayload(payload?: string): Uint8Array {
  return new TextEncoder().encode(payload);
}

export function encodeJsonPayload(payload?: any): Uint8Array {
  return encodePayload(JSON.stringify(payload));
}

export function decodePayload(payload?: Uint8Array | string): string {
  if (typeof payload === "string") return payload;
  return new TextDecoder().decode(payload);
}

export function decodeJsonPayload(payload?: Uint8Array | string): any {
  return JSON.parse(decodePayload(payload));
}

/**
 * Encode a Uint8Array to a base64 string without relying on the `btoa` global,
 * which is not available in all JS runtimes (e.g. QuickJS).
 */
export function uint8ToBase64(bytes: Uint8Array): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let result = "";
  const len = bytes.length;
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < len ? bytes[i + 1] : 0;
    const b2 = i + 2 < len ? bytes[i + 2] : 0;
    result += chars[b0 >> 2];
    result += chars[((b0 & 3) << 4) | (b1 >> 4)];
    result += i + 1 < len ? chars[((b1 & 15) << 2) | (b2 >> 6)] : "=";
    result += i + 2 < len ? chars[b2 & 63] : "=";
  }
  return result;
}
