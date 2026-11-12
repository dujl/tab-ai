export function taskPath(tree, key) {
  const result = [],
    seen = new Set();
  let node = tree.nodes.get(key);
  while (node && !seen.has(node.key)) {
    seen.add(node.key);
    result.unshift(node);
    node = tree.nodes.get(node.parentKey);
  }
  return result;
}
export function taskRoot(tree, key) {
  return taskPath(tree, key)[0];
}
export function isInBranch(tree, key, ancestor) {
  return taskPath(tree, key).some((n) => n.key === ancestor);
}
export function taskColumns(tree, focusKey, selectedKey, visible) {
  const focus = tree.nodes.get(focusKey);
  if (!focus) return [];
  const path = taskPath(tree, selectedKey),
    start = path.findIndex((n) => n.key === focusKey);
  if (start < 0)
    return [
      { parent: focus, children: focus.children.filter((n) => !visible || visible.has(n.key)) },
    ];
  // Slide the visible window as selection goes deeper; keep the ancestor path.
  const offset = Math.max(start, path.length - 4),
    parents = path.slice(offset, offset + 3),
    result = [];
  if (!parents.length) parents.push(focus);
  for (const parent of parents) {
    result.push({
      parent,
      children: parent.children.filter((n) => !visible || visible.has(n.key)),
    });
    if (!parent.children.length) break;
  }
  return result;
}
export function outlineRows(tree, focusKey, collapsed = new Set(), visible) {
  const rows = [],
    seen = new Set();
  const visit = (n, depth) => {
    if (!n || seen.has(n.key) || (visible && !visible.has(n.key))) return;
    seen.add(n.key);
    rows.push({ node: n, depth });
    if (!collapsed.has(n.key)) for (const child of n.children) visit(child, depth + 1);
  };
  visit(tree.nodes.get(focusKey), 0);
  return rows;
}
