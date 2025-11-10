export interface Flow {
  onMessage(message: Message, context: Context): Promise<Message[]>;
  onInterval?(time: Date, context: Context): Promise<Message[]>;
}

export interface Message {
  time?: Date;
  topic: string;
  payload: Uint8Array;
  transportFields?: {
    retain?: boolean;
    [key: string]: any;
  };
}

export function decodeJSON(data?: Uint8Array): any {
  return JSON.parse(new TextDecoder().decode(data));
}

export function decodeText(data?: Uint8Array): string {
  return new TextDecoder().decode(data);
}

export function encodeJSON(data?: any): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(data));
}

export function encodeText(data?: string): Uint8Array {
  return new TextEncoder().encode(data);
}

export interface Context {
  readonly runtime?: "thin-edge.io";

  /** Get state */
  getState?(key: string, defaultValue?: any): any;

  /** Set state. Not shared across flow instances */
  setState?(key: string, value: any): void;

  /** Flow configuration object, for parameterization. */
  readonly config: any;
}

export async function Run(
  module: Flow,
  messages: Message[],
  config: any,
): Promise<Message[]> {
  const outputMessages: Message[] = [];
  messages.forEach(async (message) => {
    message.time = new Date();
    const output = await module.onMessage(message, config);
    outputMessages.push(...output);
    if (output.length > 0) {
      console.log(JSON.stringify(output));
    }
  });

  if (module.onInterval) {
    const output = await module.onInterval(new Date(), config);
    outputMessages.push(...output);
    console.log(JSON.stringify(output));
  }
  return outputMessages;
}

// Check if the topic references the main device
export function isMainDevice(topic: string): boolean {
  return !!topic.match(/^.+\/device\/main\/.*\/.*\//);
}
