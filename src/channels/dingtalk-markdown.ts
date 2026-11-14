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
  return /(^|\n)\s{0,3}(?:#{1,6}\s|[-*]\s|\d+\.\s)|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\//.test(
    text,
  );
}

// Budget the encoded payload, while retaining source text for a definite
// Markdown rejection. Splitting never cuts a Unicode code point or entity.
export function dingMarkdownParts(
  text: string,
  maxBytes = 5000,
): { plain: string; markdown: string }[] {
  if (maxBytes < 6) throw new Error('maxBytes must be at least 6');
  const parts: { plain: string; markdown: string }[] = [];
  let plain = '',
    markdown = '',
    bytes = 0;
  for (const character of text) {
    const encoded = escapeHtml(character),
      size = Buffer.byteLength(encoded);
    while (bytes + size > maxBytes) {
      const paragraph = plain.lastIndexOf('\n\n');
      const line = plain.lastIndexOf('\n');
      const cut = paragraph >= 0 ? paragraph + 2 : line >= 0 ? line + 1 : plain.length;
      const head = plain.slice(0, cut);
      parts.push({ plain: head, markdown: escapeHtml(head) });
      plain = plain.slice(cut);
      markdown = escapeHtml(plain);
      bytes = Buffer.byteLength(markdown);
    }
    plain += character;
    markdown += encoded;
    bytes += size;
  }
  if (plain) parts.push({ plain, markdown });
  return parts;
}
