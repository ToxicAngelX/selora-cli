/**
 * /v1/models family — PUBLIC routes, always called with auth:'none'. This is
 * load-bearing: the gateway only returns the internal flavor (the only one
 * WITH pricing) when NO Authorization header is sent. Decoding is defensive
 * (Object.hasOwn guards + fallbacks) per the /root defect class.
 */

import type { SeloraClient } from '../client.js';

export interface ModelPricing {
  /** USD per 1M input tokens, scale-6 decimal string. */
  input_per_1m: string;
  /** USD per 1M output tokens, scale-6 decimal string. */
  output_per_1m: string;
}

export interface ModelSummary {
  id: string;
  provider: string;
  status: string;
  pricing: ModelPricing;
  display_name: string;
  /** Only models that support the 1M-token context carry `true` on the wire. */
  supports_1m_context: boolean;
}

export interface ModelDetail {
  id: string;
  provider: string;
  status: string;
  pricing: ModelPricing;
  /** Raw JSONB from the gateway — expect {}. Never invented. */
  limits: Record<string, unknown>;
  metadata: Record<string, unknown>;
  display_name: string;
}

function str(rec: Record<string, unknown>, key: string, fallback = ''): string {
  const v = Object.hasOwn(rec, key) ? rec[key] : undefined;
  return typeof v === 'string' ? v : fallback;
}

function bool(rec: Record<string, unknown>, key: string): boolean {
  const v = Object.hasOwn(rec, key) ? rec[key] : undefined;
  return v === true;
}

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function decodePricing(v: unknown): ModelPricing {
  const p = rec(v);
  if (p === null) return { input_per_1m: '', output_per_1m: '' };
  return { input_per_1m: str(p, 'input_per_1m'), output_per_1m: str(p, 'output_per_1m') };
}

export async function listModels(client: SeloraClient): Promise<ModelSummary[]> {
  const res = await client.request<unknown>('/v1/models', { auth: 'none' });
  const root = rec(res);
  const arr = root !== null && Array.isArray(root['models']) ? root['models'] : [];
  return arr
    .map((row) => {
      const m = rec(row);
      if (m === null) return null;
      return {
        id: str(m, 'id'),
        provider: str(m, 'provider'),
        status: str(m, 'status'),
        pricing: decodePricing(Object.hasOwn(m, 'pricing') ? m['pricing'] : undefined),
        display_name: str(m, 'display_name'),
        supports_1m_context: bool(m, 'supports_1m_context'),
      };
    })
    .filter((x): x is ModelSummary => x !== null);
}

export async function getModel(client: SeloraClient, id: string): Promise<ModelDetail> {
  const res = await client.request<unknown>(`/v1/models/${encodeURIComponent(id)}`, { auth: 'none' });
  const root = rec(res);
  const m = root !== null ? rec(root['model']) : null;
  if (m === null) {
    return {
      id,
      provider: '',
      status: '',
      pricing: { input_per_1m: '', output_per_1m: '' },
      limits: {},
      metadata: {},
      display_name: '',
    };
  }
  return {
    id: str(m, 'id') !== '' ? str(m, 'id') : id,
    provider: str(m, 'provider'),
    status: str(m, 'status'),
    pricing: decodePricing(Object.hasOwn(m, 'pricing') ? m['pricing'] : undefined),
    limits: rec(Object.hasOwn(m, 'limits') ? m['limits'] : undefined) ?? {},
    metadata: rec(Object.hasOwn(m, 'metadata') ? m['metadata'] : undefined) ?? {},
    display_name: str(m, 'display_name'),
  };
}
