import type { Question } from './types.js';

export interface ElicitationField {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array';
  enum?: string[];
  labels?: string[];
  minLength?: number;
  maxLength?: number;
  format?: 'email' | 'uri' | 'date' | 'date-time';
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('不支持的表单结构');
  return value as Record<string, unknown>;
};
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const checkKeys = (value: Record<string, unknown>, keys: string[]) => {
  if (Object.keys(value).some((k) => !keys.includes(k))) throw Error('表单包含暂不支持的约束');
};
const size = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
function options(raw: Record<string, unknown>) {
  const one = (raw.oneOf ?? raw.anyOf) as unknown[] | undefined,
    values = one ? one.map((o) => text(object(o).const)) : (raw.enum as string[] | undefined);
  const titles = one
    ? one.map((o) => text(object(o).title))
    : (raw.enumNames as string[] | undefined);
  if (
    !values ||
    !Array.isArray(values) ||
    !values.length ||
    values.length > 50 ||
    values.some((v) => typeof v !== 'string' || !v.length) ||
    new Set(values).size !== values.length
  )
    throw Error('不支持的选项结构');
  if (
    titles &&
    (!Array.isArray(titles) ||
      titles.length !== values.length ||
      titles.some((t) => typeof t !== 'string'))
  )
    throw Error('选项标题无效');
  const labels = values.map((v, i) => (titles?.[i] && titles[i] !== v ? `${titles[i]} — ${v}` : v));
  if (new Set(labels).size !== labels.length) throw Error('选项标题重复');
  return { enum: values, labels };
}
export function elicitationQuestions(raw: unknown): Question[] {
  const schema = object(raw);
  checkKeys(schema, [
    'type',
    'properties',
    'required',
    '$schema',
    'additionalProperties',
    'title',
    'description',
  ]);
  if (schema.type !== 'object' || typeof schema.additionalProperties === 'object')
    throw Error('不支持的表单结构');
  const properties = object(schema.properties ?? {}),
    required = schema.required ?? [];
  if (
    !Array.isArray(required) ||
    required.some((k) => typeof k !== 'string' || !Object.hasOwn(properties, k))
  )
    throw Error('必填字段无效');
  const entries = Object.entries(properties);
  if (entries.length > 20) throw Error('表单字段过多');
  return entries.map(([id, value]) => {
    if (!id || id.length > 100 || ['__proto__', 'constructor', 'prototype'].includes(id))
      throw Error('敏感或不支持的字段');
    const f = object(value),
      type = f.type as ElicitationField['type'];
    if (
      !['string', 'number', 'integer', 'boolean', 'array'].includes(type) ||
      f.writeOnly === true ||
      f.format === 'password' ||
      (type === 'string' &&
        /password|passcode|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key|密码|验证码/i.test(
          [id, f.title, f.description].join(' '),
        ))
    )
      throw Error('敏感或不支持的字段');
    const field: ElicitationField = { type };
    const common = ['type', 'title', 'description', 'default'];
    if (type === 'string') {
      checkKeys(f, [...common, 'enum', 'enumNames', 'oneOf', 'minLength', 'maxLength', 'format']);
      if (f.enum !== undefined || f.oneOf !== undefined) Object.assign(field, options(f));
      for (const k of ['minLength', 'maxLength'] as const)
        if (f[k] !== undefined) {
          if (!size(f[k])) throw Error('长度约束无效');
          field[k] = f[k] as number;
        }
      if (f.format !== undefined) {
        if (!['email', 'uri', 'date', 'date-time'].includes(String(f.format)))
          throw Error('不支持的输入格式');
        field.format = f.format as ElicitationField['format'];
      }
    } else if (type === 'array') {
      checkKeys(f, [...common, 'items', 'minItems', 'maxItems']);
      const items = object(f.items);
      checkKeys(items, ['type', 'enum', 'enumNames', 'oneOf', 'anyOf']);
      if (items.type !== undefined && items.type !== 'string') throw Error('不支持的多选结构');
      Object.assign(field, options(items));
      for (const k of ['minItems', 'maxItems'] as const)
        if (f[k] !== undefined) {
          if (!size(f[k])) throw Error('选项数量约束无效');
          field[k] = f[k] as number;
        }
    } else if (type === 'boolean') checkKeys(f, common);
    else {
      checkKeys(f, [...common, 'minimum', 'maximum']);
      for (const k of ['minimum', 'maximum'] as const)
        if (f[k] !== undefined) {
          if (typeof f[k] !== 'number' || !Number.isFinite(f[k])) throw Error('数值范围无效');
          field[k] = f[k] as number;
        }
    }
    if (
      (field.minLength !== undefined &&
        field.maxLength !== undefined &&
        field.minLength > field.maxLength) ||
      (field.minimum !== undefined &&
        field.maximum !== undefined &&
        field.minimum > field.maximum) ||
      (field.minItems !== undefined &&
        field.maxItems !== undefined &&
        field.minItems > field.maxItems)
    )
      throw Error('表单约束矛盾');
    const hints = [
      f.description,
      field.minimum !== undefined ? `最小值 ${field.minimum}` : '',
      field.maximum !== undefined ? `最大值 ${field.maximum}` : '',
      field.minLength !== undefined ? `至少 ${field.minLength} 字符` : '',
      field.maxLength !== undefined ? `最多 ${field.maxLength} 字符` : '',
      field.format ? `格式 ${field.format}` : '',
      field.minItems !== undefined ? `至少选 ${field.minItems} 项` : '',
      field.maxItems !== undefined ? `最多选 ${field.maxItems} 项` : '',
    ]
      .filter((v) => typeof v === 'string' && v)
      .join('；');
    return {
      id,
      question: `${text(f.title) || id}${required.includes(id) ? '' : '（可选，可留空）'}${hints ? '\n' + hints : ''}`,
      optional: !required.includes(id),
      inputSchema: field,
      options: type === 'boolean' ? ['是（true）', '否（false）'] : field.labels,
      multiSelect: type === 'array',
      allowOther: !field.enum && type !== 'boolean',
    };
  });
}
export function elicitationValue(question: Question, values: string[]): unknown {
  const f = question.inputSchema!;
  const fail = () => {
    throw Error(`字段 ${question.id} 不符合要求，请检查选项、格式或范围。`);
  };
  if (
    !Array.isArray(values) ||
    values.some((v) => typeof v !== 'string' || v.length > 8000) ||
    new Set(values).size !== values.length
  )
    return fail();
  if (!values.length && question.optional) return undefined;
  if (f.type === 'array') {
    if (values.length < (f.minItems ?? 0) || values.length > (f.maxItems ?? 50)) return fail();
    return values.map((v) => {
      const i = question.options?.indexOf(v) ?? -1;
      if (i < 0) return fail();
      return f.enum![i];
    });
  }
  if (values.length > 1) return fail();
  const value = values[0] ?? '';
  if (f.type === 'boolean') {
    if (value === '是（true）') return true;
    if (value === '否（false）') return false;
    return fail();
  }
  if (f.type === 'number' || f.type === 'integer') {
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) return fail();
    const n = Number(value);
    if (
      !Number.isFinite(n) ||
      (f.type === 'integer' && !Number.isSafeInteger(n)) ||
      (f.minimum !== undefined && n < f.minimum) ||
      (f.maximum !== undefined && n > f.maximum)
    )
      return fail();
    return n;
  }
  let result = value;
  if (f.enum) {
    const i = question.options?.indexOf(value) ?? -1;
    if (i < 0) return fail();
    result = f.enum[i]!;
  }
  const length = Array.from(result).length;
  if (length < (f.minLength ?? 0) || length > (f.maxLength ?? 8000)) return fail();
  if (f.format === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) return fail();
  if (f.format === 'uri') {
    try {
      new URL(result);
    } catch {
      return fail();
    }
  }
  if (
    f.format === 'date' &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(result) ||
      !Number.isFinite(Date.parse(result)) ||
      new Date(result).toISOString().slice(0, 10) !== result)
  )
    return fail();
  if (
    f.format === 'date-time' &&
    (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(result) ||
      !Number.isFinite(Date.parse(result)))
  )
    return fail();
  return result;
}
export function elicitationContent(questions: Question[], answers: Record<string, string[]>) {
  return Object.fromEntries(
    questions
      .map((q) => [q.id, elicitationValue(q, answers[q.id] ?? [])])
      .filter(([, v]) => v !== undefined),
  );
}
export function safeElicitationUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length > 8000) return;
  try {
    const url = new URL(raw);
    if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) return raw;
  } catch {}
  return;
}
