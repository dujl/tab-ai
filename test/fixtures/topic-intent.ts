// Deterministic fixture for transport/lifecycle regression tests only.
// Production uses NativeTopicRouter and never calls this phrase matcher.
export function newTopicIntent(text: string): { task?: string } | undefined {
  const match =
    /^(?:(?:请帮我|帮我|请)\s*)?(?:新开|新建|创建|开启)\s*(?:一个\s*)?(?:话题|会话|session)([\s\S]*)$/i.exec(
      text.trim(),
    );
  if (!match) return;
  const suffix = match[1]!.trim();
  if (!suffix || /^[。！!]$/.test(suffix)) return {};
  // Accept ordinary task continuations, including the common “，用于 …”.
  // Preserve the user's task wording/inner whitespace instead of manufacturing
  // a prompt. A separator or purpose phrase prevents matching “sessionId …”.
  const separated = /^[，,：:；;]\s*([\s\S]+)$/.exec(suffix);
  if (separated) {
    const task = separated[1]!.trim();
    if (task) return { task };
  }
  if (/^(?:用于|用来|来|帮我|帮忙)\s*\S/.test(suffix)) return { task: suffix };
  if (/^\s*\r?\n/.test(match[1]!) && suffix) return { task: suffix };
  return;
}
