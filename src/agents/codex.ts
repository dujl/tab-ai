import { AppServerAdapter } from './app-server.js';

export class CodexAdapter extends AppServerAdapter {
  constructor(command = 'codex', secretKeys: string[] = [], maxIdleWorkers = 8) {
    super('codex', command, secretKeys, maxIdleWorkers);
  }
}
