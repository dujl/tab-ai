import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const packageMode = process.argv.includes('--package');
const packageFiles = packageMode
  ? new Set(JSON.parse(readFileSync(0, 'utf8'))[0].files.map((file) => file.path))
  : undefined;
const files = [];
function collect(dir) {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const file = resolve(dir, item.name);
    if (item.isDirectory()) collect(file);
    else if (extname(file) === '.md') files.push(file);
  }
}
collect(resolve(root, 'docs'));
for (const file of readdirSync(root)) if (extname(file) === '.md') files.push(resolve(root, file));
function prose(text) {
  let fence;
  return text
    .split('\n')
    .map((line) => {
      const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (marker) {
        if (!fence) fence = marker[0];
        else if (marker[0] === fence) fence = undefined;
        return '';
      }
      return fence ? '' : line;
    })
    .join('\n');
}
function anchors(file) {
  const text = readFileSync(file, 'utf8');
  if (extname(file) !== '.md')
    return new Set([...text.matchAll(/\b(?:id|name)=["']([^"']+)["']/g)].map((m) => m[1]));
  const used = new Map();
  return new Set(
    [...prose(text).matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)].map((m) => {
      const base = m[1]
        .toLowerCase()
        .replace(/<[^>]*>/g, '')
        .replace(/[^\p{L}\p{N}_\-\s]/gu, '')
        .replace(/\s/g, '-');
      const count = used.get(base) ?? 0;
      used.set(base, count + 1);
      return base + (count ? `-${count}` : '');
    }),
  );
}
const errors = [];
let links = 0;
for (const file of files) {
  if (packageFiles && !packageFiles.has(relative(root, file).split('\\').join('/')))
    errors.push(`${relative(root, file)}: 文档未包含在安装包中`);
  const text = prose(readFileSync(file, 'utf8'));
  for (const match of text.matchAll(/!?\[[^\]\n]*\]\((<[^>]+>|[^\s)]+)(?:\s+["'][^"']*["'])?\)/g)) {
    const href = match[1].replace(/^<|>$/g, '');
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) continue;
    links++;
    try {
      const [pathname, fragment] = href.split('#');
      const target = pathname
        ? resolve(dirname(file), decodeURIComponent(pathname.split('?')[0]))
        : file;
      if (!existsSync(target)) throw Error('文件不存在');
      if (packageFiles && !packageFiles.has(relative(root, target).split('\\').join('/')))
        throw Error('链接目标未包含在安装包中');
      if (
        fragment &&
        statSync(target).isFile() &&
        ['.md', '.html'].includes(extname(target)) &&
        !anchors(target).has(decodeURIComponent(fragment))
      )
        throw Error('锚点不存在');
    } catch (error) {
      errors.push(`${relative(root, file)}: ${href} — ${error.message}`);
    }
  }
}
const schemaSources = [
  'src/core/store.ts',
  'src/core/report-store.ts',
  'src/core/task-migration.ts',
]
  .map((file) => readFileSync(resolve(root, file), 'utf8'))
  .join('\n');
const tables = new Set(
  [...schemaSources.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]),
);
for (const match of readFileSync(resolve(root, 'docs/database.md'), 'utf8').matchAll(
  /^\|\s*`(\w+)`\s*\|/gm,
))
  if (!tables.has(match[1])) errors.push(`docs/database.md: 未定义的表 ${match[1]}`);
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else
  console.log(
    `Validated ${packageMode ? 'package: ' : ''}${files.length} Markdown documents, ${links} local links and the documented database tables.`,
  );
