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
