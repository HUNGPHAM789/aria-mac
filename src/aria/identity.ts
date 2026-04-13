import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { upsertTrait, getTraits } from '../db/index';

const IDENTITY_PATH = join(process.cwd(), 'identity', 'aria-identity.md');

export function loadIdentity(): string {
  if (!existsSync(IDENTITY_PATH)) {
    return '# ARIA\nI am ARIA, an adaptive reasoning assistant.';
  }
  return readFileSync(IDENTITY_PATH, 'utf-8');
}

export function loadTraitsFromDb(): Record<string, string> {
  return getTraits();
}

export function updateIdentityTraits(newTraits: Record<string, string>): void {
  for (const [key, value] of Object.entries(newTraits)) {
    upsertTrait(key, value);
  }
  refreshIdentityTraitsSection();
}

function refreshIdentityTraitsSection(): void {
  if (!existsSync(IDENTITY_PATH)) return;

  const traits = getTraits();
  const traitLines = Object.entries(traits)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join('\n');

  let content = readFileSync(IDENTITY_PATH, 'utf-8');

  // Replace the ## Current Traits section content
  content = content.replace(
    /(## Current Traits\n)([\s\S]*?)(\n## |\n*$)/,
    (_, header, _oldTraits, ending) => `${header}${traitLines}\n${ending}`,
  );

  writeFileSync(IDENTITY_PATH, content, 'utf-8');
}

export function appendEvolutionLog(entry: string): void {
  if (!existsSync(IDENTITY_PATH)) return;

  const date = new Date().toISOString().split('T')[0];
  const line = `- ${date}: ${entry}`;

  let content = readFileSync(IDENTITY_PATH, 'utf-8');
  content = content.replace(
    /(## Evolution Log\n)/,
    `$1${line}\n`,
  );
  writeFileSync(IDENTITY_PATH, content, 'utf-8');
}
