export function savedNotePrefix(note: string): string {
  let prefix = [...note].slice(0, 240).join("");
  if (prefix.endsWith("\r") && note[prefix.length] === "\n") prefix = prefix.slice(0, -1);
  let line = 1;
  for (const ending of prefix.matchAll(/\r\n|[\r\n\u2028\u2029]/gu)) {
    if (line === 4) return prefix.slice(0, ending.index);
    line += 1;
  }
  return prefix;
}
