import { AppServerAdapter } from './app-server.js';

export class TraecliAdapter extends AppServerAdapter {
  constructor(command = 'traecli', secretKeys: string[] = [], maxIdleWorkers = 8) {
    super('traecli', command, secretKeys, maxIdleWorkers);
  }
}
