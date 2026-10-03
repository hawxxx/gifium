import type { Limits } from './types.js';

export interface BackendRequest {
  input: Uint8Array;
  args: string[];
  fps?: number;
  limits: Limits;
}

export interface BackendResponse {
  output?: Uint8Array;
  warnings?: string[];
  error?: string;
}
