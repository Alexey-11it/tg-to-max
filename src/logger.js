import fs from 'node:fs';
import path from 'node:path';

export function createLogger(workDir) {
  fs.mkdirSync(workDir, { recursive: true });
  const logFile = path.join(workDir, 'import.log');
  const failedFile = path.join(workDir, 'failed.json');

  const stream = fs.createWriteStream(logFile, { flags: 'a', encoding: 'utf-8' });

  function write(level, message) {
    const now = new Date();
    const ts = now.toISOString().replace('T', ' ').slice(0, 19);
    const line = `[${ts}] [${level}] ${message}`;

    if (level === 'ERROR') {
      console.error(line);
    } else {
      console.log(line);
    }
    stream.write(line + '\n');
  }

  function recordFailed(entry) {
    let list = [];
    try {
      list = JSON.parse(fs.readFileSync(failedFile, 'utf-8'));
    } catch {
      list = [];
    }
    list.push({ ...entry, recordedAt: new Date().toISOString() });
    fs.writeFileSync(failedFile, JSON.stringify(list, null, 2), 'utf-8');
  }

  function close() {
    return new Promise((resolve) => stream.end(resolve));
  }

  return {
    info: (msg) => write('INFO', msg),
    warn: (msg) => write('WARN', msg),
    error: (msg) => write('ERROR', msg),
    recordFailed,
    close,
  };
}