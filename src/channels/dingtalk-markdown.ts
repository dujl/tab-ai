import { PROJECT_URL } from '../brand.js';
import { managementActions } from '../core/management-view.js';
import type { ManagementView } from '../core/types.js';

const escapeHtml = (text: string) =>
  text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
const literal = (text: string) => text.replace(/([\\`*_[\]#])/g, '\\$1');
const inline = (text: string) => literal(text.replace(/[\r\n]+/g, ' '));

export function dingManagementMarkdown(view: ManagementView): string {
  const sections = [`### ${inline(view.title)}`];
  const info = view.information;
  if (info) {
    const fields =
      view.action === 'status'
        ? info.fields
        : info.fields.filter((f) => ['Agent', '模型', '工作目录'].includes(f.label));
    sections.push(`**${inline(info.name)}** · ${inline(info.status)}`);
    sections.push(
      fields.map((f) => `**${inline(f.label)}**：${literal(f.shortValue ?? f.value)}`).join('  \n'),
    );
    if (view.action === 'status' && info.details.length)
      sections.push(
        '#### 详细信息\n\n' +
          info.details.map((f) => `**${inline(f.label)}**：${literal(f.value)}`).join('  \n'),
      );
  }
  let body = view.text;
  if (info && view.session) {
    const anchor = `【${info.name} · ${view.session.id.slice(0, 8)}】\n`;
    if (body.startsWith(anchor)) body = body.slice(anchor.length);
  }
  if (body.trim()) sections.push(literal(body));
  const actions = managementActions(view);
  if (actions.length)
    sections.push(
      '#### 操作\n\n复制命令发送：\n\n' +
        actions
          .map(
            (b) =>
              `**${inline(b.label)}**${b.disabledReason ? `（暂不可用：${inline(b.disabledReason)}）` : ''}  \n${literal(b.command)}`,
          )
          .join('\n\n'),
    );
  sections.push(`[tab-ai 项目主页](${PROJECT_URL})`);
  return sections.filter(Boolean).join('\n\n');
}

export function hasDingMarkdown(text: string): boolean {
  return /(^|\n)\s{0,3}(?:#{1,6}\s|[-*]\s|\d+\.\s|`{3,}|~{3,})|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\//.test(
    text,
  );
}

// Keep paragraphs and fenced blocks intact. An oversized or incomplete block
// retains its exact source as text rather than emitting broken rich syntax.
export function dingMarkdownParts(
  text: string,
  maxBytes = 5000,
): { plain: string; markdown: string; format: 'text' | 'markdown' }[] {
  if (maxBytes < 6) throw new Error('maxBytes must be at least 6');
  const parts: ReturnType<typeof dingMarkdownParts> = [];
  let pending = '';
  const push = (plain: string, format: 'text' | 'markdown') => {
    if (plain) parts.push({ plain, markdown: escapeHtml(plain), format });
  };
  const flush = () => {
    push(pending, 'markdown');
    pending = '';
  };
  const block = (source: string, complete = true) => {
    if (complete && Buffer.byteLength(escapeHtml(source)) <= maxBytes) {
      if (Buffer.byteLength(escapeHtml(pending + source)) > maxBytes) flush();
      pending += source;
      return;
    }
    flush();
    let plain = '',
      bytes = 0;
    for (const character of source) {
      const size = Buffer.byteLength(escapeHtml(character));
      if (bytes + size > maxBytes) {
        push(plain, 'text');
        plain = '';
        bytes = 0;
      }
      plain += character;
      bytes += size;
    }
    push(plain, 'text');
  };
  let source = '',
    fence: string | undefined;
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*?)(?:\r?\n)?$/.exec(line);
    if (!fence && marker && !(marker[1]![0] === '`' && marker[2]!.includes('`'))) {
      if (source) block(source);
      source = line;
      fence = marker[1]!;
    } else {
      source += line;
      if (
        fence &&
        marker &&
        marker[1]![0] === fence[0] &&
        marker[1]!.length >= fence.length &&
        !marker[2]!.trim()
      ) {
        block(source);
        source = '';
        fence = undefined;
      } else if (!fence && !line.trim()) {
        block(source);
        source = '';
      }
    }
  }
  if (source) block(source, !fence);
  flush();
  return parts;
}
