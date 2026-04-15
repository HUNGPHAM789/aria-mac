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
