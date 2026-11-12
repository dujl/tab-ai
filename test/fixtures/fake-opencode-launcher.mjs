import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const child = spawn(process.execPath, [new URL('./fake-opencode.mjs', import.meta.url).pathname], {
  stdio: 'inherit',
  env: process.env,
});
writeFileSync(process.env.TEST_OPENCODE_NATIVE_PID, String(child.pid));
