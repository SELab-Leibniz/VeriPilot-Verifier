// OpenClaw 2026.10.3's public V2 service contract detaches scheduled work
// from the terminal RPC admission while retaining the plugin's lifetime.
export function registerStopWorkOwner(api, sharedState) {
  if (api.runtime.version !== "2026.10.3") return undefined;
  const owner = sharedState.stopWorkOwner ??= {
    scheduler: null,
    execute({ id, signal, run }) {
      const scheduler = this.scheduler;
      if (!scheduler || scheduler.signal.aborted) return Promise.reject(Object.assign(
        new Error("RC Stop service is unavailable."), { code: "RC_STOP_OWNER_UNAVAILABLE" }));
      return new Promise((resolve, reject) => {
        let started = false, handle;
        const closed = () => {
          if (started) return; // Running work observes the lifetime signal and is joined by the host.
          handle?.cancel();
          cleanup();
          reject(Object.assign(new Error("RC Stop service was cancelled."), { code: "RC_STOP_OWNER_CANCELLED" }));
        };
        const cleanup = () => {
          signal.removeEventListener("abort", closed);
          scheduler.signal.removeEventListener("abort", closed);
        };
        signal.addEventListener("abort", closed, { once: true });
        scheduler.signal.addEventListener("abort", closed, { once: true });
        if (signal.aborted || scheduler.signal.aborted) { closed(); cleanup(); return; }
        try {
          handle = scheduler.schedule({ id, delayMs: 0, run: async () => {
            started = true;
            try { resolve(await run({ ownerSignal: scheduler.signal })); }
            catch (error) { reject(error); }
            finally { cleanup(); }
          } });
        } catch (error) { cleanup(); reject(error); }
      });
    },
  };
  api.registerService({ apiVersion: 2, id: "runtime-corrector-stop",
    start({ scheduler }) {
      if (scheduler?.version !== 1) throw new Error("RC_STOP_SCHEDULER_CONTRACT_UNAVAILABLE");
      owner.scheduler = scheduler;
    },
    stop({ scheduler }) { if (owner.scheduler === scheduler) owner.scheduler = null; },
  });
  return owner;
}
