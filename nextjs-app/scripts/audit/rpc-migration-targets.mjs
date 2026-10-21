/** Recognize the reviewed function-body patch forms, not read-only SQL references. */
export function functionBodyPatchTargets(source) {
  const targets = new Set();
  const signature = /'public\.([a-z][a-z0-9_]*)\([^']*\)'/gi;
  const blocks = /\bdo\s+(\$[a-z_][a-z0-9_]*\$|\$\$)([\s\S]*?)\1\s*;/gi;
  const executable = source.replace(/--[^\r\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const block of executable.matchAll(blocks)) {
    const body = block[2];
    const isPatched = (variable) => new RegExp(`\\breplace\\s*\\(\\s*${variable}\\b`, "i").test(body)
      && new RegExp(`\\bexecute\\s+(?:replace\\s*\\(\\s*)?${variable}\\b`, "i").test(body);
    const addSignatures = (text) => {
      for (const match of text.matchAll(signature)) targets.add(match[1]);
    };

    const literal = /\b([a-z_][a-z0-9_]*)(?:\s+text)?\s*:=\s*(?:pg_catalog\.)?pg_get_functiondef\s*\(\s*('public\.[a-z][a-z0-9_]*\([^']*\)')\s*::\s*regprocedure\s*\)/gi;
    for (const match of body.matchAll(literal)) {
      if (isPatched(match[1])) addSignatures(match[2]);
    }

    const values = /\bfor\s+([a-z_][a-z0-9_]*)\s+in\s+select\s+\*\s+from\s*\(\s*values\s+([\s\S]*?)\)\s+as\s+[a-z_][a-z0-9_]*\s*\(\s*signature\s*,\s*anchor\s*\)\s+loop/gi;
    for (const match of body.matchAll(values)) {
      const definition = body.match(new RegExp(`\\b([a-z_][a-z0-9_]*)\\s*:=\\s*(?:pg_catalog\\.)?pg_get_functiondef\\s*\\(\\s*${match[1]}\\.signature\\s*::\\s*regprocedure\\s*\\)`, "i"));
      if (definition && isPatched(definition[1])) {
        // Each reviewed VALUES tuple starts with its patch target signature.
        addSignatures([...match[2].matchAll(/\(\s*('public\.[a-z][a-z0-9_]*\([^']*\)')/gi)].map(row => row[1]).join("\n"));
      }
    }

    const arrays = /\bforeach\s+([a-z_][a-z0-9_]*)\s+in\s+array\s+array\s*\[([\s\S]*?)\]\s+loop/gi;
    for (const match of body.matchAll(arrays)) {
      const definition = body.match(new RegExp(`\\bselect\\s+(?:pg_catalog\\.)?pg_get_functiondef\\s*\\(\\s*([a-z_][a-z0-9_]*\\.[a-z_][a-z0-9_]*)\\s*\\)[\\s\\S]*?\\binto\\s+([a-z_][a-z0-9_]*)[\\s\\S]*?\\bwhere\\s+\\1\\s*=\\s*${match[1]}\\s*::\\s*regprocedure\\s*;`, "i"));
      if (definition && isPatched(definition[2])) addSignatures(match[2]);
    }
  }
  return [...targets];
}
