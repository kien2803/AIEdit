let counter = 0;
export function newId(prefix: string): string {
  counter = (counter + 1) % 0xffff;
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}_${Math.floor(
    Math.random() * 0xffff,
  ).toString(36)}`;
}
