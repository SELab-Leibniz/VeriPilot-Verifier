// Existing correction/budget fixtures start with an admitted project scope.
// The host binding/permissions/activation contract is exercised separately in
// openclaw-session-projects.test.mjs using the real scope service.
export function admittedProjectScopes(api) {
  return {
    async resolve(event = {}, ctx = {}) {
      const root = ctx.workspaceDir ?? event.cwd ?? api.runtime.agent.resolveAgentWorkspaceDir?.(api.config, ctx.agentId ?? "main");
      return { enabled: true, projectRoot: root, executionDirectory: root, fingerprint: root };
    },
    async activate() { return {}; },
  };
}

export function correctionFixtureRuntime(createRuntime) {
  return (api, options) => createRuntime(api, { ...options, projectScopes: admittedProjectScopes(api) });
}
