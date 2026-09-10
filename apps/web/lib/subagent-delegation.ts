/** Strip legacy delegation metadata when displaying already-stored conversations. */
export function stripSubagentDelegationPrompt(message: string): string {
  return message.replace(/\n*<pi-web-subagent-delegation>[\s\S]*?<\/pi-web-subagent-delegation>\s*$/, "").trimEnd();
}
