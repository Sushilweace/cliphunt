// Highlight ranking and post copy. Gemini, Anthropic, or local Ollama. No SDK.

import { estimateTokens } from './usage.js';

const host = () => (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');

export function llmProvider() {
  const choice = (process.env.LLM_PROVIDER || 'auto').toLowerCase();
  if (choice === 'none') return 'none';
  if (choice === 'gemini') return process.env.GEMINI_API_KEY ? 'gemini' : 'none';
  if (choice === 'anthropic') return process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'none';
  if (choice === 'openrouter') return process.env.OPENROUTER_API_KEY ? 'openrouter' : 'none';
  if (choice === 'ollama') return 'ollama';
  if (process.env.GEMINI_API_KEY) return 'gemini';
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.OPENROUTER_API_KEY) return 'openrouter';
  return 'ollama';
}

export const llmEnabled = () => llmProvider() !== 'none';

export async function llm(system, user, { maxTokens = 4000 } = {}) {
  const provider = llmProvider();
  if (provider === 'gemini') return gemini(system, user, maxTokens);
  if (provider === 'anthropic') return anthropic(system, user, maxTokens);
  if (provider === 'openrouter') return openrouter(system, user, maxTokens);
  if (provider === 'ollama') return ollama(system, user, maxTokens);
  throw new Error('No LLM configured');
}

async function gemini(system, user, maxTokens) {
  const model = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': process.env.GEMINI_API_KEY,
      },
      signal: AbortSignal.timeout(Number(process.env.GEMINI_TIMEOUT_MS || 60000)),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: maxTokens,
          responseMimeType: 'application/json',
        },
      }),
    }
  );
  if (!r.ok) throw new Error(`Gemini ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  const text = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  if (!text) throw new Error('Gemini returned an empty reply');
  const u = j.usageMetadata || {};
  const usage = u.totalTokenCount
    ? { input: u.promptTokenCount || 0, output: u.candidatesTokenCount || 0, total: u.totalTokenCount }
    : estimateTokens(system, user, text);
  return { text, usage };
}

async function anthropic(system, user, maxTokens) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5',
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!r.ok) throw new Error(`LLM ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  const text = j.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const u = j.usage || {};
  const usage = u.input_tokens
    ? { input: u.input_tokens, output: u.output_tokens || 0, total: u.input_tokens + (u.output_tokens || 0) }
    : estimateTokens(system, user, text);
  return { text, usage };
}

async function openrouter(system, user, maxTokens) {
  const model = process.env.OPENROUTER_MODEL || 'anthropic/claude-sonnet-4.5';
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
    },
    signal: AbortSignal.timeout(Number(process.env.OPENROUTER_TIMEOUT_MS || 120000)),
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature: 0.2,
      // DeepSeek V4 spends the token budget on hidden reasoning and can return an empty JSON reply.
      ...(model.includes('deepseek') ? { reasoning: { enabled: false } } : {}),
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!r.ok) throw new Error(`OpenRouter ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  const text = j.choices?.[0]?.message?.content || '';
  if (!text) throw new Error('OpenRouter returned an empty reply');
  const u = j.usage || {};
  const usage = u.total_tokens
    ? { input: u.prompt_tokens || 0, output: u.completion_tokens || 0, total: u.total_tokens }
    : estimateTokens(system, user, text);
  return { text, usage };
}

async function ollama(system, user, maxTokens) {
  const r = await fetch(`${host()}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(Number(process.env.OLLAMA_TIMEOUT_MS || 180000)),
    body: JSON.stringify({
      model: process.env.OLLAMA_MODEL || 'llama3.2:3b',
      stream: false,
      format: 'json',
      options: {
        temperature: 0.2,
        num_predict: Math.min(maxTokens, Number(process.env.OLLAMA_NUM_PREDICT || 1200)),
        num_ctx: Number(process.env.OLLAMA_NUM_CTX || 8192),
      },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!r.ok) throw new Error(`Ollama ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  const text = j.message?.content || '';
  if (!text) throw new Error('Ollama returned an empty reply');
  const input = j.prompt_eval_count || 0;
  const output = j.eval_count || 0;
  const usage = input || output ? { input, output, total: input + output } : estimateTokens(system, user, text);
  return { text, usage };
}

/** First complete JSON value, ignoring markdown fences and trailing notes. */
export function parseJSON(text) {
  if (text == null || !String(text).trim()) throw new Error('Empty model response');
  let raw = String(text).trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) raw = fence[1].trim();
  const start = raw.search(/[\[{]/);
  if (start < 0) throw new Error('Model did not return JSON');
  return JSON.parse(extractBalanced(raw, start));
}

function extractBalanced(s, i) {
  const open = s[i];
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let j = i; j < s.length; j++) {
    const ch = s[j];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return s.slice(i, j + 1);
    }
  }
  throw new Error('Truncated JSON from model');
}
