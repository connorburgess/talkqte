// JSON.parse validates grammar; a second bounded scan rejects duplicate keys,
// including equivalent escaped spellings that JSON.parse would silently replace.
export function parseUniqueLabJson(text) {
  const value = JSON.parse(text);
  const stack = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      for (i++; i < text.length; i++) {
        if (text[i] === '\\') i++;
        else if (text[i] === '"') break;
      }
      const object = stack.at(-1);
      if (object?.keys && object.key) {
        const key = JSON.parse(text.slice(start, i + 1));
        if (object.keys.has(key)) throw new Error('Duplicate JSON key.');
        object.keys.add(key);
      }
    } else if (c === '{') stack.push({ keys: new Set(), key: true });
    else if (c === '[') stack.push({});
    else if (c === '}' || c === ']') stack.pop();
    else if (c === ':' && stack.at(-1)?.keys) stack.at(-1).key = false;
    else if (c === ',' && stack.at(-1)?.keys) stack.at(-1).key = true;
  }
  return value;
}
