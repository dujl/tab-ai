import type { Session } from '../core/types.js';
// Ephemeral, exact native-proposal grants. No project/user config is written.
export class ScopedGrants {
  private entries = new Map<string, { workspace: string; values: Set<string> }>();
  private bucket(session: Session) {
    let b = this.entries.get(session.id);
    if (b?.workspace !== session.workspace) {
      b = { workspace: session.workspace, values: new Set() };
      this.entries.set(session.id, b);
    }
    return b!;
  }
  values(session: Session): unknown[] {
    return [...this.bucket(session).values].map((v) => JSON.parse(v));
  }
  has(session: Session, value: unknown) {
    return this.bucket(session).values.has(JSON.stringify(value));
  }
  add(session: Session, value: unknown) {
    this.bucket(session).values.add(JSON.stringify(value));
  }
  clear(id: string) {
    this.entries.delete(id);
  }
  close() {
    this.entries.clear();
  }
}
