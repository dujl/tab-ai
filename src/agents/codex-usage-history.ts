import { AppServerUsageHistory } from './app-server-usage-history.js';

export class CodexUsageHistory extends AppServerUsageHistory {
  constructor(home?: string) {
    super('codex', home);
  }
}
