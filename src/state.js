import fs from 'node:fs/promises';
import path from 'node:path';

export async function loadState(statePath) {
  try {
    const raw = await fs.readFile(statePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {
      lastProcessedId: 0,
      totalSent: 0,
      totalFailed: 0,
      updatedAt: null,
    };
  }
}

export async function saveState(statePath, state) {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  const payload = {
    ...state,
    updatedAt: new Date().toISOString(),
  };
  // Атомарная запись, чтобы state.json не повредился при внезапном выключении ПК
  const tmpPath = `${statePath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(payload, null, 2), 'utf-8');
  await fs.rename(tmpPath, statePath);
}