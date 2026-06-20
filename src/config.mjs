import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function loadConfig(configPath = 'local-fusion.config.json') {
  const absolute = resolve(process.cwd(), configPath);
  const data = await readFile(absolute, 'utf8');
  return JSON.parse(data);
}
