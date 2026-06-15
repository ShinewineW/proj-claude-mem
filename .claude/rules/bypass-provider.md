---
paths:
  - "src/services/worker/BypassLane.ts"
  - "src/services/worker/openai-compatible-probe.ts"
  - "src/shared/openai-compatible-base-url.ts"
  - "src/shared/SettingsDefaultsManager.ts"
---
# Bypass Provider — config-driven, no per-provider churn [MUST]

The bypass lane has exactly two transports: `claude` (main SDK) and `openai` (any
OpenAI-compatible endpoint). Adding or switching an OpenAI-compatible provider is
**config-only** — set `CLAUDE_MEM_OPENAI_{BASE_URL,API_KEY,MODEL}`; identity derives
from the `baseUrl` host. **Never** add a per-provider enum value, code branch, or
renamed settings key. That "rewrite everything per provider" churn was explicitly and
repeatedly rejected (rationale: ADR 0003). Homogeneous peers that differ only in
config get one config-driven path, not per-instance code.
