// MA requires named CommonJS lifecycle exports. The OpenClaw payload stays ESM.
function run(name, api, init) {
  return import('./installer.mjs').then(installer => installer[name](api, init)).catch(error => {
    const message = error instanceof Error ? error.message : String(error);
    api?.logger?.error?.(`[runtime-corrector] ${name}: ${message}`);
    return { error: message };
  });
}

module.exports = {
  activate(api, init) { return run('activate', api, init); },
  deactivate(api, init) { return run('deactivate', api, init); },
};
