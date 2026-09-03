import type { MessageFile } from "@bevyl-ai/agent-tools";
import type { AddressMode } from "./common";

export type EventPayload = {
  text: string;
  ts: string | null;
  principalName?: string | undefined;
  addressMode?: AddressMode | undefined;
  files?: MessageFile[] | undefined;
  isBot?: boolean | undefined;
};
