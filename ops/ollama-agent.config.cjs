/**
 * A second Ollama, isolated from the box's shared one.
 *
 * The shared daemon on 11434 is used by whatsscale-ai and runs with
 * OLLAMA_NUM_PARALLEL=4, which reserves KV cache for four concurrent slots.
 * At a 16k context that is roughly 9.6GB on a box with under 4GB free, so a
 * 4B model cannot load there at all — and retuning a daemon another product
 * depends on, for a side experiment, is the wrong trade.
 *
 * This instance serves only job-applier-agent:
 *   NUM_PARALLEL=1     one agent runs at a time; four slots buy nothing
 *   KV_CACHE_TYPE=q4_0 16k KV drops from ~2416MB to ~604MB
 *   own OLLAMA_MODELS  no root-owned files in the ollama user's store
 *
 * Budget with those settings: ~2500MB weights + ~604MB KV = ~3.1GB.
 */
module.exports = {
  apps: [
    {
      name: 'ollama-agent',
      script: '/usr/local/bin/ollama',
      args: 'serve',
      env: {
        OLLAMA_HOST: '127.0.0.1:11435',
        OLLAMA_MODELS: '/root/.ollama-agent/models',
        OLLAMA_NUM_PARALLEL: '1',
        OLLAMA_KV_CACHE_TYPE: 'q4_0',
        OLLAMA_MAX_LOADED_MODELS: '1',
        // Long enough for a slow CPU prefill on a large prompt.
        OLLAMA_LOAD_TIMEOUT: '15m',
        OLLAMA_KEEP_ALIVE: '30m',
      },
      autorestart: true,
      max_restarts: 5,
    },
  ],
};
