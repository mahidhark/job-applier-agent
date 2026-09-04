# ops

## Why this repo runs its own Ollama

The box already runs Ollama on **11434**, shared with `whatsscale-ai`
(`src/agent.ts`, `src/tools/retrieve_knowledge.ts`, `src/server.ts`). That
daemon has a deliberate override, `OLLAMA_NUM_PARALLEL=4`, which reserves KV
cache for four concurrent slots. At a 16k context that is roughly **9.6GB** on
a box with under 4GB free, so a 4B model cannot load there at all.

Retuning a daemon another product depends on, for a side experiment, is the
wrong trade. So this repo runs its own instance on **11435** with its own model
store, and the shared one is never touched.

```
OLLAMA_HOST=127.0.0.1:11435
OLLAMA_MODELS=/root/.ollama-agent/models
OLLAMA_NUM_PARALLEL=1          one agent at a time; four slots buy nothing
OLLAMA_KV_CACHE_TYPE=q4_0      16k KV: ~2416MB -> ~604MB
OLLAMA_MAX_LOADED_MODELS=1
OLLAMA_LOAD_TIMEOUT=15m        CPU prefill on a large prompt is slow by nature
```

Budget: ~2500MB of weights + ~604MB of KV ≈ 3.1GB against ~3.9GB free.

## Bringing it up on a fresh box

```bash
pm2 start ops/ollama-agent.config.cjs

mkdir -p /root/.ollama-agent/gguf
curl -L -C - --retry 10 --retry-all-errors \
  -o /root/.ollama-agent/gguf/Qwen3.5-4B-UD-Q4_K_XL.gguf \
  https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-UD-Q4_K_XL.gguf

OLLAMA_HOST=127.0.0.1:11435 ollama create qwen3.5-4b-agent \
  -f ops/Modelfile.qwen3.5-4b-agent
```

`ollama pull hf.co/...` times out against HuggingFace on this connection; the
direct curl resumes and is what actually works.

## Do not

- Point `ai.ollama.baseUrl` at 11434. It reproduces the original failure, and
  the symptom — zero tool calls, no error — looks like the model failing.
- Change `OLLAMA_NUM_PARALLEL` on the shared daemon. It would serialise
  whatsscale-ai's inference.
- Rely on `num_ctx` being passed per request through the AI SDK. Bake it into
  the model.
