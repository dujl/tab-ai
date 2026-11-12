// Do not leak the host bot's routing environment or connector credentials into agents.
// Login HOME, PATH and native agent configuration are preserved.
export function agentEnvironment(secretKeys: string[] = []): NodeJS.ProcessEnv {
  const result = { ...process.env };
  for (const key of Object.keys(result)) {
    if (
      /^(BOTMUX_|TAB_AI_|GENESISBOT_|NATIVMUX_)/.test(key) ||
      [
        'CODEX_SESSION_ID',
        'CODEX_THREAD_ID',
        'CODEX_TOOL_CALL_ID',
        'CLAUDECODE',
        'CLAUDE_CODE_SESSION_ID',
      ].includes(key) ||
      secretKeys.includes(key)
    )
      delete result[key];
  }
  return result;
}
