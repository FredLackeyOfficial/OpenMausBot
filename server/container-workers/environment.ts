export function validateWorkerEnvironment(environment: Record<string, string>): void {
  for (const name of Object.keys(environment)) {
    if (["OMB_OPENAI_API_KEY", "OMB_OPENROUTER_API_KEY", "OMB_ANTHROPIC_API_KEY"].includes(name)) continue;
    if (/^(OMB_|DOCKER_|XDG_|DYLD_|LD_)/i.test(name) || /^(HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TMPDIR|TMP|TEMP|PATH|NODE_OPTIONS|NODE_PATH|SSH_AUTH_SOCK|SSH_AGENT_PID|CODEX_HOME|CLAUDE_CONFIG_DIR)$/i.test(name)) {
      throw new Error(`Worker environment cannot override reserved variable ${name}`);
    }
  }
}
