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
      "Reply and react using [rN] tags on New lines (or the conversation header to post). Messages can come from different threads; answer each where it belongs.",
    tools: ["reply", "react", "step_back"],
  },
  { name: "scheduling", tools: ["set_wake"] },
  { name: "outcome", tools: ["task_complete", "task_fail", "task_ask"] },
  {
    name: "memory",
    skill:
      "Everything you've ever heard in your channels is searchable, and memory is how you stay smart across threads. " +
      "Before you guess, say you don't know, or make a claim about a past discussion, search for the receipt. " +
      "memory_write defaults to archive (searchable). Use tier:'core' only for member-'remember X' or confirmed standing law; core rides every conversation, so keep it to what must always be in mind.",
    tools: ["memory_write", "memory_retract", "memory_tier", "search"],
  },
];
