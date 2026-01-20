export interface Flow {
  onMessage(message: Message, config: any): Message[];
  onInterval?: (time: Date, config: any) => Message[];
  onConfigUpdate?: (message: Message, config: any) => void;
}

export interface Message {
  time: Date;
  topic: string;
  payload: string;
  raw_payload?: Uint8Array<ArrayBufferLike>;
  retain?: boolean;
}

export function mockGetTime(time: Date = new Date()): Date {
  return time;
}

export function Run(module: Flow, messages: Message[], config: any): Message[] {
  const outputMessages: Message[] = [];
  messages.forEach((message) => {
    message.time = new Date();
    const output = module.onMessage(message, config);
    outputMessages.push(...output);
    if (output.length > 0) {
      console.log(JSON.stringify(output));
    }
  });

  if (module.onInterval) {
    const output = module.onInterval(new Date(), config);
    outputMessages.push(...output);
    console.log(JSON.stringify(output));
  }
  return outputMessages;
}

// Check if the topic references the main device
export function isMainDevice(topic: string): boolean {
  return !!topic.match(/^.+\/device\/main\/.*\/.*\//);
}
