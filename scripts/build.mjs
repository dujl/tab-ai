import { mkdtempSync, existsSync, renameSync, rmSync, cpSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const staging = mkdtempSync(join(root, '.tab-ai-build-'));
const output = join(staging, 'dist');
const previous = join(staging, 'previous');
const target = join(root, 'dist');
try {
  execFileSync(
    process.execPath,
    [join(root, 'node_modules/typescript/bin/tsc'), '--outDir', output],
    { cwd: root, stdio: 'inherit' },
  );
  cpSync(join(root, 'src/web/public'), join(output, 'web/public'), { recursive: true });
  chmodSync(join(output, 'cli.js'), 0o755);
  if (existsSync(target)) renameSync(target, previous);
  try {
    renameSync(output, target);
  } catch (error) {
    if (existsSync(previous)) renameSync(previous, target);
    throw error;
  }
} finally {
  rmSync(staging, { recursive: true, force: true });
}
