import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { upsertSkill, getAllSkills } from '../db/index';

const SKILLS_DIR = join(homedir(), '.claude', 'skills');

export interface SkillDefinition {
  skill_name: string;
  description: string;
  content: string;
}

export function createSkill(skill: SkillDefinition): string {
  // Ensure ~/.claude/skills/ exists
  if (!existsSync(SKILLS_DIR)) {
    mkdirSync(SKILLS_DIR, { recursive: true });
  }

  // Sanitize to safe kebab-case filename
  const safeName = skill.skill_name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  const filePath = join(SKILLS_DIR, `${safeName}.md`);
  writeFileSync(filePath, skill.content, 'utf-8');

  // Register in SQLite
  upsertSkill(safeName, skill.description, skill.content);

  console.log(`[ARIA] Skill created: ${safeName} → ${filePath}`);
  return filePath;
}

export function listSkills(): { skill_name: string; description: string }[] {
  return getAllSkills();
}
