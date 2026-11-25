// Do not leak the host bot's routing environment or connector credentials into agents.
// Login HOME, PATH and native agent configuration are preserved.
export function agentEnvironment(secretKeys: string[] = []): NodeJS.ProcessEnv {
  const result = { ...process.env };
  for (const key of Object.keys(result)) {
    if (
      /^(BOTMUX_|TAB_AI_|GENESISBOT_|NATIVMUX_)/.test(key) ||
      [
        'BOTMUX',
        'TRAECLI_THREAD_ID',
        'TRAECLI_SESSION_INBOX',
        'TRAECLI_SESSION_ID',
        'CODEX_SESSION_ID',
        'CODEX_THREAD_ID',
        'CODEX_TOOL_CALL_ID',
        'CLAUDECODE',
        'CLAUDE_CODE_SESSION_ID',
        'ANTIGRAVITY_CONVERSATION_ID',
        'ANTIGRAVITY_TRAJECTORY_ID',
        'ANTIGRAVITY_LS_ADDRESS',
        'ANTIGRAVITY_CSRF_TOKEN',
        'ANTIGRAVITY_SOURCE_METADATA',
        'ANTIGRAVITY_AGENTAPI_EXE',
        'ANTIGRAVITY_AGENT',
        'ANTIGRAVITY_LS_VERSION',
        'ANTIGRAVITY_PROJECT_ID',
      ].includes(key) ||
      secretKeys.includes(key)
    )
      delete result[key];
  }
  return result;
}
