// Client-safe chat config allowlists. No DB/secret imports so this can be used
// from browser components (Settings) as well as server credential code.
export const CHAT_MODELS = [
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
] as const;
export const CHAT_EFFORTS = ["low", "medium", "high", "xhigh"] as const;
export const DEFAULT_CHAT_MODEL = "claude-opus-5";
export const DEFAULT_CHAT_EFFORT = "xhigh";
