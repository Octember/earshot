import type { ToolGroup } from "../tools/catalog-types";

export const BUILTIN_GROUPS: ToolGroup[] = [
  {
    name: "tasks",
    skill:
      "Delegation is how heavy work leaves your turn: a worker runs the task on its own budget and reports back to you. " +
      "Anything beyond a few checks and a reply belongs in a task rather than inline in your turn.",
    tools: ["task_create", "task_steer", "task_cancel", "task_query"],
  },
  {
    name: "posting",
    skill:
      "Every line you are shown starts with its [channel ts]. Reply with channel + thread_ts (the thread root), react with channel + ts. Messages can come from different threads; answer each where it belongs.",
    tools: ["reply", "react", "step_back"],
  },
  { name: "scheduling", tools: ["set_wake"] },
  { name: "outcome", tools: ["task_complete", "task_fail", "task_ask"] },
];
