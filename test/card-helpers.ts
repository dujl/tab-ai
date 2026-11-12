export function cardElements(card: any): any[] {
  const result: any[] = [];
  function visit(node: any): void {
    if (!node || typeof node !== 'object') return;
    if (node.tag) result.push(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  }
  visit(card.body ?? card);
  return result;
}
export const callbackValue = (element: any) =>
  element.behaviors?.find((b: any) => b.type === 'callback')?.value ?? element.value;
