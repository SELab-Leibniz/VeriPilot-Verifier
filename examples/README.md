# Examples

Self-contained sample projects and policies for the Runtime Corrector plugin.
Nothing in this directory is loaded automatically; copy what you need into
your own project.

- `veripilot-guarded-delivery/` is a pipeline-specific sample for the
  VeriPilot guarded-delivery pipeline. It contains the `run-guarded-delivery`
  orchestration skill (kept out of `skills/` so it does not auto-load with the
  plugin) and the `guarded-delivery-workflow` authority files it executes.
