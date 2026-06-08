/**
 * Model capability helper for tool-use support.
 *
 * Provider catalogs can opt a model out via `compat.supportsTools === false`;
 * absent metadata remains permissive for older catalog entries. The local
 * enhancement keeps `id`/`provider` on the parameter shape so we can emit
 * `[openclaw:model-tool-support]` diagnostics for production troubleshooting.
 */
let lastSupportsToolsWarning: string | undefined;

export function supportsModelTools(model: {
  compat?: unknown;
  id?: string;
  provider?: string;
}): boolean {
  const compat =
    model.compat && typeof model.compat === "object"
      ? (model.compat as { supportsTools?: boolean })
      : undefined;
  const supports = compat?.supportsTools !== false;

  if (!supports) {
    const key = `${model.provider ?? "unknown"}/${model.id ?? "unknown"}`;
    const msg = `tools disabled: model ${key} has supportsTools=false in compat config`;
    if (msg !== lastSupportsToolsWarning) {
      lastSupportsToolsWarning = msg;
      console.warn(`[openclaw:model-tool-support] ${msg}`);
    }
  }

  return supports;
}
