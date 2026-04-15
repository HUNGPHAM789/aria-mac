// Barrel export for the provider abstraction.
export type {
  Provider,
  ProviderCapabilities,
  ProviderChatOptions,
  ProviderChatResponse,
  ProviderMessage,
  ProviderToolDef,
} from './types.js';
export { OllamaProvider, type OllamaProviderConfig } from './ollama.js';
export { ClaudeProvider, type ClaudeProviderConfig } from './claude.js';
export { OpenRouterProvider, type OpenRouterProviderConfig } from './openrouter.js';
export { GeminiProvider, type GeminiProviderConfig } from './gemini.js';
export {
  CredentialPool,
  credentialsFromEnv,
  parseEnvList,
  idForValue,
  type CredentialEntry,
  type CredentialPoolOptions,
} from './pool.js';
export { resolveChain, makeChain, type ProviderBinding } from './chain.js';
export {
  runWithFallback,
  ProviderChainExhaustedError,
  type RunWithFallbackOptions,
  type RunWithFallbackResult,
  type ProviderAttempt,
} from './orchestrator.js';
