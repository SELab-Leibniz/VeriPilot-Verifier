export function statusFromDiagnostics(diagnostics) {
  if (diagnostics.some((item) => item.severity === "error")) return "failed";
  if (diagnostics.some((item) => item.severity === "pending")) return "pending";
  if (diagnostics.some((item) => item.severity === "warning")) return "warning";
  return "passed";
}
