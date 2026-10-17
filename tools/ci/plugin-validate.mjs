import fs from 'node:fs';
import path from 'node:path';
import Ajv from 'ajv';
import { root, readJSON, relative, localPath, pluginDir, declaredPaths, componentDeclarations } from './common.mjs';

let passed = 0;
let failed = 0;
function check(ok, label) {
  console.log((ok ? 'PASS ' : 'FAIL ') + label);
  if (ok) passed++; else failed++;
}
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
// JSON manifest presence checks intentionally use JavaScript trimming.
// YAML 1.2 separation is only SPACE/TAB; indentation is only SPACE. CRLF
// and CR are normalized to LF at the frontmatter boundary. NEL, LS, PS,
// NBSP and all other Unicode spaces (including FEFF) remain scalar content.
const trimSeparation = (value) => value.replace(/^[ \t\r\n]+|[ \t\r\n]+$/gu, '');
const yamlNonempty = (value) => typeof value === 'string' && trimSeparation(value).length > 0;
const reservedPlainStart = /^[`@&*!|>'"%#\[\]{},]/u;
// Check Unicode code points so paired surrogates remain valid astral text.
// Apply the same document character set to source and decoded escapes; no
// scalar style may admit controls, lone surrogates or plane-ending FFFE/FFFF.
function yamlPrintable(value) {
  for (const char of value) {
    const cp = char.codePointAt(0);
    if (!(cp === 0x09 || cp === 0x0a || cp === 0x0d ||
        (cp >= 0x20 && cp <= 0x7e) || cp === 0x85 ||
        (cp >= 0xa0 && cp <= 0xd7ff) ||
        (cp >= 0xe000 && cp <= 0xfffd) ||
        (cp >= 0x10000 && cp <= 0x10ffff && (cp & 0xffff) < 0xfffe))) return false;
  }
  return true;
}
const keys = new Set([
  '$schema', 'name', 'version', 'description', 'author', 'homepage', 'repository',
  'license', 'keywords', 'commands', 'agents', 'skills', 'hooks', 'mcpServers',
  'outputStyles', 'themes', 'channels', 'lspServers', 'monitors', 'settings',
  'userConfig', 'dependencies', 'strict',
]);

// The same complete scalar rules apply to top-level fields and nested
// block mapping/sequence values. Flow tokens are checked by the scanner below.
function foldSourceLines(value) {
  return value.replace(/[ \t]*(?:(?:\r\n|[\r\n])[ \t]*)+/gu,
    (run) => {
      // YAML flow folding trims adjacent separation whitespace, folds one
      // physical break to a space, and preserves each additional blank line.
      // A closing quote does not change how a trailing break run folds.
      const breaks = run.match(/\r\n|[\r\n]/gu).length;
      return breaks === 1 ? ' ' : '\n'.repeat(breaks - 1);
    });
}

function scalarValue(text, valuePosition = true, allowQuotedLines = false) {
  if (!yamlPrintable(text)) return null;
  // Strip comments before classifying even empty/flow/block values. Hashes
  // inside quoted spans (including escaped/doubled quotes) stay literal.
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (quote === '"' && char === '\\') i++;
      else if (char === quote) {
        if (quote === "'" && text[i + 1] === "'") i++;
        else quote = '';
      }
    } else if ((char === '"' || char === "'") &&
        (i === 0 || /[ \t\r\n\[{:,-]/u.test(text[i - 1]))) quote = char;
    else if (char === '#' && (i === 0 || /[ \t\r\n]/u.test(text[i - 1]))) {
      text = text.slice(0, i);
      break;
    }
  }
  const value = trimSeparation(text);
  const result = { value, block: /^[|>](?:[1-9][-+]?|[-+][1-9]?)?$/u.test(value), flow: /^[\[{]/u.test(value) };
  if (value.startsWith('"')) {
    const quoted = value.match(/^("(?:[^"\\]|\\.)*")[ \t]*(#[^\n]*)?$/su);
    if (!quoted || (valuePosition && !allowQuotedLines && /[\r\n]/u.test(quoted[1]))) return null;
    // AG4 permits physical line breaks in quoted keys. Fold their source
    // layout before decoding so escape-produced characters stay verbatim.
    const source = !valuePosition || allowQuotedLines
      ? '"' + foldSourceLines(quoted[1].slice(1, -1)) + '"' : quoted[1];
    // YAML permits literal TAB in quoted content; JSON needs it escaped.
    try { result.scalar = JSON.parse(source.replace(/\r\n|\r|\n/gu, '\\n').replaceAll('\t', '\\t')); } catch { return null; }
  } else if (value.startsWith("'")) {
    const quoted = value.match(/^'((?:[^']|'')*)'[ \t]*(#[^\n]*)?$/su);
    if (!quoted) return null;
    const source = !valuePosition || allowQuotedLines ? foldSourceLines(quoted[1]) : quoted[1];
    result.scalar = source.replaceAll("''", "'");
  } else if (!result.flow && !result.block) {
    if (reservedPlainStart.test(value)) return null;
    if (valuePosition && /^[-?](?:[ \t]|$)/u.test(value)) return null;
    if (/:(?:[ \t\r\n]|$)/u.test(value)) return null;
  }
  if (result.scalar !== undefined && !yamlPrintable(result.scalar)) return null;
  return result;
}

// Read physical block lines before the structural scanner can trim or skip
// them. Only indentation is removed; spaces and tabs in content stay verbatim.
function blockScalar(lines, start, parentIndent, header) {
  const explicit = header.match(/[1-9]/u);
  let contentIndent = explicit ? parentIndent + Number(explicit[0]) : undefined;
  if (contentIndent === undefined) {
    let leadingIndent = 0;
    for (let i = start; i < lines.length; i++) {
      const indent = lines[i].match(/^ */u)[0].length;
      if (indent === lines[i].length) {
        leadingIndent = Math.max(leadingIndent, indent);
        continue;
      }
      if (indent <= parentIndent) break;
      if (leadingIndent > indent) return null;
      contentIndent = indent;
      break;
    }
  }
  let value = '';
  let emptyLines = 0;
  let hasContent = false;
  let moreIndented = false;
  let next = start;
  for (; next < lines.length; next++) {
    const line = lines[next];
    if (!yamlPrintable(line)) return null;
    const indent = line.match(/^ */u)[0].length;
    if (indent === line.length && (contentIndent === undefined || indent <= contentIndent)) {
      emptyLines++;
      continue;
    }
    if (indent < (contentIndent ?? parentIndent + 1)) {
      if (indent > parentIndent) return null;
      break;
    }
    const content = line.slice(contentIndent);
    const more = /^[ \t]/u.test(content);
    if (header[0] === '|' || more || moreIndented) {
      value += '\n'.repeat(emptyLines + (hasContent ? 1 : 0));
    } else {
      value += emptyLines ? '\n'.repeat(emptyLines) : hasContent ? ' ' : '';
    }
    value += content;
    emptyLines = 0;
    hasContent = true;
    moreIndented = more;
  }
  // Every captured line has a physical terminator, including the last line
  // before the closing frontmatter delimiter. Empty clip scalars stay empty.
  if (header.includes('+')) value += '\n'.repeat(emptyLines + (hasContent ? 1 : 0));
  else if (!header.includes('-') && hasContent) value += '\n';
  return { value, next };
}

// Locate a block mapping separator outside quoted keys and flow collections.
function mappingEntry(text) {
  // Explicit block keys (including multi-line complex keys) are outside this
  // subset. Do not accidentally treat their '?' indicator as scalar content.
  if (/^[ \t]*\?(?:[ \t]|$)/u.test(text)) return null;
  let quote = '';
  const brackets = [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (quote === '"' && char === '\\') i++;
      else if (char === quote) {
        if (quote === "'" && text[i + 1] === "'") i++;
        else quote = '';
      }
    } else if ((char === '"' || char === "'") &&
        (i === 0 || /[ \t\r\n\[{:,-]/u.test(text[i - 1]))) quote = char;
    else if (char === '#' && (i === 0 || /[ \t\r\n]/u.test(text[i - 1]))) break;
    else if (char === '[' || char === '{') brackets.push(char);
    else if (char === ']' || char === '}') {
      if (brackets.pop() !== (char === ']' ? '[' : '{')) return null;
    } else if (char === ':' && !brackets.length && /[ \t\r\n]|^$/u.test(text[i + 1] || '')) {
      const key = scalarValue(text.slice(0, i), false);
      return key && !key.block ? { key, value: text.slice(i + 1) } : null;
    }
  }
  return null;
}

// Match js-yaml's CORE_SCHEMA resolution before removing separators. Its
// numeric grammar permits underscores after base prefixes and repeated ones
// inside digits, but not at the end; exponent digits cannot contain them.
// Prefixes and special-value spellings are deliberately case-sensitive.
function resolvePlainScalar(value) {
  if (/^(?:true|True|TRUE)$/u.test(value)) return true;
  if (/^(?:false|False|FALSE)$/u.test(value)) return false;
  if (/^(?:|~|null|Null|NULL)$/u.test(value)) return null;
  if (!value.endsWith('_') &&
      /^[+-]?(?:0|[1-9][0-9_]*|0[0-9][0-9_]*|0b[01_]*[01]|0o[0-7_]*[0-7]|0x[0-9a-fA-F_]*[0-9a-fA-F])$/u.test(value)) {
    const number = value.replaceAll('_', '');
    const sign = number.startsWith('-') ? -1 : 1;
    const digits = number.replace(/^[+-]/u, '');
    // js-yaml constructs the single zero spelling as positive zero.
    if (digits === '0') return 0;
    if (digits.startsWith('0b')) return sign * parseInt(digits.slice(2), 2);
    if (digits.startsWith('0o')) return sign * parseInt(digits.slice(2), 8);
    if (digits.startsWith('0x')) return sign * parseInt(digits.slice(2), 16);
    return sign * parseInt(digits, 10);
  }
  if (/^[+-]?\.(?:inf|Inf|INF)$/u.test(value)) return value.startsWith('-') ? -Infinity : Infinity;
  if (/^\.(?:nan|NaN|NAN)$/u.test(value)) return NaN;
  // A leading-dot float cannot have a sign in js-yaml; underscores may
  // occur immediately after the dot (even when construction yields NaN).
  if (!value.endsWith('_') &&
      /^(?:[+-]?[0-9][0-9_]*(?:\.[0-9_]*)?(?:[eE][+-]?[0-9]+)?|\.[0-9_]+(?:[eE][+-]?[0-9]+)?)$/u.test(value)) {
    const number = value.replaceAll('_', '');
    const sign = number.startsWith('-') ? -1 : 1;
    return sign * parseFloat(number.replace(/^[+-]/u, ''));
  }
  return value;
}

// Quoted keys stay strings; plain keys resolve through the same core scalar
// rules as required field values. Primitive identities retain scalar types.
function keyIdentity(key) {
  // Quoted scalars already folded physical source lines before decoding.
  // Their exact decoded strings also define duplicate-key identity.
  if (key.scalar !== undefined) return key.scalar;
  // Plain flow keys can span lines when their value is omitted.
  return resolvePlainScalar(trimSeparation(foldSourceLines(key.value)));
}

// Each mapping owns its key set. Sibling mappings never share this state.
// Tag every node so collections cannot collide with scalar spellings, and
// quoted strings remain distinct from resolved null/boolean/number scalars.
function nodeIdentity(key) {
  if (key.identity !== undefined) return key.identity;
  const value = keyIdentity(key);
  return [value === null ? 'null' : typeof value,
    typeof value === 'number' ? String(value) : value];
}

function uniqueKey(mapping, key) {
  mapping.keys ??= new Set();
  const decoded = JSON.stringify(nodeIdentity(key));
  if (mapping.keys.has(decoded)) return false;
  mapping.keys.add(decoded);
  return true;
}

// Complete every entry, retaining collection nodes as well as scalar tokens.
// Sequences preserve element order; mapping identities sort complete pairs so
// source order cannot distinguish structurally equal complex keys.
function finishFlowEntry(flow) {
  if (!flow) return true;
  if (flow.last === flow.open || flow.last === ',') return !flow.explicitKey;
  const isKey = flow.open === '{' && !flow.inValue;
  const value = flow.collection ?? scalarValue(flow.token, !flow.explicitKey, isKey || flow.keyContext);
  if (!value) return false;
  if (isKey) {
    if (!flow.collection && (!trimSeparation(flow.token) || trimSeparation(flow.token) === '?')) return false;
    if (!uniqueKey(flow, value)) return false;
    flow.items.push([nodeIdentity(value), nodeIdentity({ value: '' })]);
  } else if (flow.inValue) {
    const pair = [flow.key, nodeIdentity(value)];
    flow.items.push(flow.open === '{' ? pair : ['mapping', [pair]]);
  } else {
    flow.items.push(nodeIdentity(value));
  }
  return true;
}

// Validate the whole supported YAML subset before reading required scalars.
// Unsupported/ambiguous structure fails closed without a YAML dependency.
function frontmatter(text) {
  text = text.replace(/\r\n|\r/gu, '\n');
  const match = text.match(/^---\n(.*?)\n---(?:\n|$)/su);
  if (!match) return null;
  const fields = {};
  const lines = match[1].split('\n');
  const entries = new Map();
  const brackets = [];
  let quote = '';
  let quotedToken = '';
  let current;
  let previousValue;
  let levels = [{ indent: 0, kind: 'mapping' }];
  let flowValue = false;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    let blockKey;
    let blockNext;
    if (!yamlPrintable(line) ||
        (!quote && !brackets.length && /^ *\t/u.test(line))) return null;
    // Empty physical lines inside quotes contribute to flow-scalar folding.
    if (!trimSeparation(line) && !quote) continue;
    const indent = line.match(/^ */u)[0].length;
    if (!quote && /^[ \t]*#/u.test(line)) continue;
    // A completed value cannot own a deeper block. Keep the value's key
    // indent (after sequence markers), not merely the line's leading indent.
    // Open flow/block values retain their owner until their structure ends.
    if (previousValue?.complete && indent > previousValue.indent) return null;
    const field = indent === 0 && !/^-(?:[ \t\r\n]|$)/u.test(line) ? mappingEntry(line) : null;
    if (field) {
      const key = keyIdentity(field.key);
      if (quote || brackets.length || entries.has(key) || field.key.flow) return null;
      const value = scalarValue(field.value);
      if (!value) return null;
      current = { ...value, continuations: [] };
      levels = [{ indent: 0, kind: 'mapping' }];
      previousValue = { indent: 0, empty: !value.value, complete: !value.block && Boolean(value.value) };
      flowValue = value.flow;
      entries.set(key, current);
      if (value.block) {
        const decoded = blockScalar(lines, lineIndex + 1, indent, value.value);
        if (!decoded) return null;
        current.scalar = decoded.value;
        lineIndex = decoded.next - 1;
        continue;
      }
    } else if (trimSeparation(line)) {
      if (!current || !/^(?: +[^ \t]|-[ \t])/u.test(line)) return null;
      if (!quote && !brackets.length) {
        let content = trimSeparation(line);
        const kind = /^-(?:[ \t\r\n]|$)/u.test(content) ? 'sequence' : 'mapping';
        // Only an empty value opens a structural level. Sequences may also
        // start at their parent key's indent; mapping children must be deeper.
        if (indent > levels.at(-1).indent) {
          if (!previousValue?.empty || indent <= previousValue.indent) return null;
          levels.push({ indent });
        } else {
          while (levels.at(-1).indent > indent) levels.pop();
          if (levels.at(-1).indent !== indent) return null;
        }
        if (kind === 'mapping' && levels.at(-1).indentationless) levels.pop();
        if (kind === 'sequence' && levels.at(-1).kind === 'mapping' &&
            previousValue?.empty && previousValue.indent === indent) {
          levels.push({ indent, kind: 'sequence', indentationless: true });
        }
        const level = levels.at(-1);
        level.kind ??= kind;
        if (level.kind !== kind) return null;
        let keyIndent = indent;
        // A sequence item may itself contain a mapping or another sequence.
        let itemIndent = indent;
        while (/^-[ \t]/u.test(content)) {
          itemIndent = keyIndent;
          const marker = content.match(/^-[ \t]+/u)[0];
          keyIndent += marker.length;
          content = content.slice(marker.length);
          if (/^-[ \t]/u.test(content) || mappingEntry(content)) {
            // Separation before a scalar may contain tabs. The same columns
            // before a compact block mapping/sequence are indentation spaces.
            if (marker.includes('\t')) return null;
            levels.push({ indent: keyIndent, kind: /^-[ \t]/u.test(content) ? 'sequence' : 'mapping' });
          }
        }
        if (content === '-') content = '';
        const nested = mappingEntry(content);
        if (kind === 'mapping' && !nested) return null;
        if (nested?.key.flow) {
          // The structural scanner below completes inline collection keys.
          // Checking their raw source here would miss nested scalar folding
          // and unordered mapping equivalence.
          blockKey = { mapping: levels.at(-1), source: nested.key.value };
        } else if (nested && !uniqueKey(levels.at(-1), nested.key)) return null;
        const value = scalarValue(nested ? nested.value : content);
        if (!value) return null;
        previousValue = {
          indent: nested ? keyIndent : itemIndent,
          empty: !value.value,
          complete: !value.block && Boolean(value.value),
        };
        flowValue = value.flow;
        if (value.block) {
          const decoded = blockScalar(lines, lineIndex + 1, previousValue.indent, value.value);
          if (!decoded) return null;
          if (!blockKey) {
            current.continuations.push(trimSeparation(line));
            lineIndex = decoded.next - 1;
            continue;
          }
          // Still scan the collection key before skipping block content.
          blockNext = decoded.next;
        }
      }
      current.continuations.push(trimSeparation(line));
    }
    // Comments and quoted text cannot open/close flow collections. A quote
    // inside a plain word (e.g. user's) is ordinary scalar content.
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (quote) {
        if (quotedToken) quotedToken += char;
        if (quote === '"' && char === '\\') {
          if (quotedToken) quotedToken += line[i + 1] || '';
          i++;
        }
        else if (char === quote) {
          if (quote === "'" && line[i + 1] === "'") {
            if (quotedToken) quotedToken += line[i + 1];
            i++;
          }
          else {
            if (quotedToken) {
              // Every flow string obeys the same complete-token rules as a
              // top-level quoted scalar, including strings in nested flows.
              if (quote === '"') {
                const owner = brackets.at(-1);
                if (!scalarValue(quotedToken, true, owner.keyContext || (owner.open === '{' && !owner.inValue))) return null;
              } else if (!/^'(?:[^']|'')*'$/u.test(quotedToken)) return null;
              brackets.at(-1).token = quotedToken;
              quotedToken = '';
            }
            quote = '';
            const flow = brackets.at(-1);
            if (flow) flow.complete = true;
          }
        }
        continue;
      }
      if (char === '#' && (i === 0 || /[ \t\r\n]/u.test(line[i - 1]))) break;
      const flow = brackets.at(-1);
      // An explicit flow-mapping key indicator precedes the key token, so
      // quoted keys still enter the ordinary quoted-scalar scanner below.
      if (flow?.open === '{' && !flow.inValue && !flow.scalar && !flow.complete &&
          char === '?' && /[ \t\r\n]/u.test(line[i + 1] ?? '\n')) {
        if (flow.explicitKey) return null;
        flow.explicitKey = true;
        continue;
      }
      if (!flow?.scalar && (char === '"' || char === "'") && (i === 0 || /[ \t\r\n\[{:,-]/u.test(line[i - 1]))) {
        if (flow && (flow.complete || flow.scalar)) return null;
        quote = char;
        quotedToken = flow ? char : '';
        if (flow) flow.last = 'quoted';
      } else if (char === '[' || char === '{') {
        if (flow && (flow.complete || flow.scalar)) return null;
        if (flow) flow.last = 'value';
        brackets.push({ open: char, last: char, inValue: false, scalar: false, complete: false,
          token: '', items: [],
          keyContext: Boolean(flow?.keyContext || (flow?.open === '{' && !flow.inValue) || blockKey),
          blockKey: !flow && blockKey ? { ...blockKey, start: i } : undefined });
        if (!flow) blockKey = undefined;
      }
      else if (char === ']' || char === '}') {
        if (!finishFlowEntry(flow)) return null;
        if (brackets.pop()?.open !== (char === ']' ? '[' : '{')) return null;
        const collection = { identity: [
          flow.open === '{' ? 'mapping' : 'sequence',
          flow.open === '{' ? flow.items.sort((a, b) => {
            const left = JSON.stringify(a), right = JSON.stringify(b);
            return left < right ? -1 : left > right ? 1 : 0;
          }) : flow.items,
        ] };
        if (flow.blockKey && (line.slice(flow.blockKey.start, i + 1) !== flow.blockKey.source ||
            !uniqueKey(flow.blockKey.mapping, collection))) return null;
        const parent = brackets.at(-1);
        if (parent) {
          parent.complete = true;
          parent.collection = collection;
        }
        // A top-level flow value ends at its matching close, including when
        // it spans lines. Only whitespace and a comment may follow it.
        if (!brackets.length && !flow.blockKey && flowValue && !/^[ \t]*(?:#[^\n]*)?$/u.test(line.slice(i + 1))) return null;
      } else if (flow && !/[ \t\r\n]/u.test(char)) {
        // State belongs to the innermost collection and survives line breaks.
        // Quoted strings are opaque tokens, so punctuation inside them cannot
        // create empty entries or mapping separators.
        if (char === ',') {
          if (flow.last === flow.open || flow.last === ',') return null;
          if (!finishFlowEntry(flow)) return null;
          flow.inValue = false;
          flow.scalar = false;
          flow.complete = false;
          flow.token = '';
          flow.collection = undefined;
          flow.key = undefined;
          flow.explicitKey = false;
        } else if (char === ':' &&
            (flow.last === 'quoted' || /[ \t\r\n\[\]{},]|^$/u.test(line[i + 1] || ''))) {
          // A sequence entry may be one implicit mapping pair. In either
          // collection, a plain value cannot contain another separator.
          if (flow.inValue) return null;
          const key = flow.collection ?? scalarValue(flow.token, false);
          if (!flow.collection && (trimSeparation(flow.token) === '?' || (flow.explicitKey && !trimSeparation(flow.token)))) return null;
          if (!flow.collection && key?.scalar === undefined && /[\r\n]/u.test(flow.token)) return null;
          if (!key || (flow.open === '{' && !uniqueKey(flow, key))) return null;
          flow.key = nodeIdentity(key);
          flow.inValue = true;
          flow.explicitKey = false;
          flow.scalar = false;
          flow.complete = false;
          flow.token = '';
          flow.collection = undefined;
        } else {
          // A completed value requires a comma or closing delimiter before
          // another value. Mapping-key colons above start their value instead.
          if (flow.complete) return null;
          if (!flow.scalar && reservedPlainStart.test(char)) return null;
          flow.scalar = true;
          flow.token += char;
        }
        flow.last = char;
      } else if (flow?.scalar) flow.token += char;
    }
    if (quotedToken) quotedToken += '\n';
    if (brackets.at(-1)?.scalar) brackets.at(-1).token += '\n';
    // Plain flow scalars continue across spaces and line breaks until a
    // collection delimiter (or a mapping-key colon) completes the token.
    if (quote || brackets.length) previousValue.complete = false;
    else if (flowValue) previousValue.complete = true;
    if (blockNext !== undefined) lineIndex = blockNext - 1;
  }
  if (quote || brackets.length) return null;
  // Top-level quoted fields cannot acquire nested continuations.
  for (const entry of entries.values()) {
    if (/^["']/u.test(entry.value) && entry.continuations.length) return null;
  }
  for (const key of ['name', 'description']) {
    const entry = entries.get(key);
    if (!entry) continue;
    let value = trimSeparation(entry.value);
    if (entry.block) {
      value = entry.scalar;
    } else if (/^["']/u.test(value)) {
      value = entry.scalar;
    } else {
      if (entry.continuations.length) return null;
      if (/:(?:[ \t\r\n]|$)/u.test(value) || reservedPlainStart.test(value) || /^[-?:](?:[ \t\r\n]|$)/u.test(value)) return null;
      // Resolve the whole scalar with the key-identity rules so every core
      // non-string is rejected, while quoted and block scalars stay strings.
      if (typeof resolvePlainScalar(value) !== 'string') return null;
    }
    fields[key] = value;
  }
  return fields;
}

try {
  const marketplace = readJSON(path.join(root, '.claude-plugin/marketplace.json'));
  const schema = readJSON(path.join(root, 'tools/ci/schemas/marketplace.schema.json'));
  const ajv = new Ajv({ strict: false, allErrors: true });
  // The vendored draft-07 schema uses only the URI format.
  ajv.addFormat('uri', (value) => {
    // This JSON URI check intentionally keeps JavaScript whitespace rules.
    try { new URL(value); return !/\s/u.test(value); } catch { return false; }
  });
  const validate = ajv.compile(schema);
  check(validate(marketplace), 'MARKETPLACE schema');
  if (validate.errors) {
    for (const error of validate.errors) console.log('FAIL SCHEMA ' + (error.instancePath || '/') + ' ' + error.message);
  }
  if (!Array.isArray(marketplace.plugins) || marketplace.plugins.length === 0) {
    check(false, 'MARKETPLACE plugins present');
  } else for (const entry of marketplace.plugins) {
    try {
      const dir = pluginDir(entry);
      const ref = relative(path.join(dir, '.claude-plugin/plugin.json'));
      const plugin = readJSON(path.join(root, ref));
      check(plugin !== null && typeof plugin === 'object' && !Array.isArray(plugin), ref + ' JSON object');
      if (!plugin || typeof plugin !== 'object' || Array.isArray(plugin)) continue;
      check(nonempty(plugin.name) && nonempty(plugin.description) &&
        plugin.author && typeof plugin.author === 'object' && nonempty(plugin.author.name), ref + ' required fields');
      check(plugin.name === entry.name && plugin.name === path.basename(dir), ref + ' name matches entry and directory');
      check(typeof plugin.version === 'string' && /^\d+\.\d+\.\d+$/u.test(plugin.version), ref + ' version');
      check(nonempty(plugin.description) && plugin.description === entry.description, ref + ' description identical');
      const unknown = Object.keys(plugin).filter((key) => !keys.has(key));
      check(unknown.length === 0, ref + ' documented keys' + (unknown.length ? ': ' + unknown.join(', ') : ''));
      let count = 0;
      const skillFiles = new Set();
      for (const { field, ref: component } of declaredPaths(componentDeclarations(plugin, entry), dir)) {
        const target = localPath(dir, component);
        check(fs.existsSync(target), ref + ' ' + field + ' path ' + component);
        count++;
        if (field === 'skills' && fs.existsSync(target)) {
          skillFiles.add(fs.statSync(target).isDirectory() ? path.join(target, 'SKILL.md') : target);
        }
      }
      check(true, ref + ' declared component paths checked=' + count);
      const skillDir = path.join(dir, 'skills');
      if (fs.existsSync(skillDir)) {
        for (const item of fs.readdirSync(skillDir, { withFileTypes: true })) {
          if (item.isDirectory()) skillFiles.add(path.join(skillDir, item.name, 'SKILL.md'));
        }
      }
      for (const skill of skillFiles) {
        const safe = localPath(dir, path.relative(dir, skill));
        const fields = fs.existsSync(safe) ? frontmatter(fs.readFileSync(safe, 'utf8')) : null;
        check(Boolean(fields && yamlNonempty(fields.name) && yamlNonempty(fields.description)), relative(skill) + ' YAML name and description');
        check(Boolean(fields && fields.name === path.basename(path.dirname(skill))), relative(skill) + ' name matches directory');
      }
    } catch (error) {
      check(false, 'PLUGIN ' + entry.name + ': ' + error.message);
    }
  }
} catch (error) {
  check(false, 'PLUGIN_VALIDATE ' + error.message);
}
console.log((failed ? 'FAIL' : 'PASS') + ' PLUGIN_VALIDATE passed=' + passed + ' failed=' + failed);
process.exitCode = failed ? 1 : 0;
