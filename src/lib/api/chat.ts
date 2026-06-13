import { createServerFn } from "@tanstack/react-start";
import { chatTurn, type ChatMessage } from "@/server/agent/chat";

export const sendChat = createServerFn({ method: "POST" })
  .inputValidator((d: { messages: ChatMessage[] }) => d)
  .handler(({ data }) => chatTurn(data.messages));
