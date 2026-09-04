import type { IdentityConfig } from "../policy";
import type { Service } from "../service";
import type { WakePostContext } from "../service-wake-post";

export interface TurnContext {
  host: Service;
  identity: IdentityConfig;
}

export interface ResidentContext extends TurnContext {
  post: WakePostContext | null;
}

export interface ExecutionContext extends TurnContext {
  taskId: string;
}
