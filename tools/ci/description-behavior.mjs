import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { root, readJSON, relative, walk, localPath, pluginDir, declaredPaths, commandReferences, componentDeclarations } from './common.mjs';

const verdict = {
  scope: 'automated pre-checks only',
  passes: true,
  violations: [],
  may_make_external_network_calls: false,
  may_download_additional_software: false,
  hooks: [],
  has_broad_scope_hooks: false,
  has_undisclosed_telemetry: false,
  description_matches_behavior: null,
  description_matches_behavior_note: 'Semantic judgment is MANUAL — see tools/ci/MANUAL_JUDGE_CHECKLIST.md. Automated pre-checks cannot set this field.',
  semantic_judge: 'MANUAL_REQUIRED',
};
const violationKeys = new Set();
const violate = (file, detail) => {
  const key = JSON.stringify([file, detail]);
  if (violationKeys.has(key)) return;
  violationKeys.add(key);
  verdict.violations.push({ file, detail });
};
// IdentifierName uses Unicode code points, including astral letters, combining
// marks and the two join controls permitted only after the first character.
// Share these classes with every name extractor and identifier boundary check.
const identifierStartSource = String.raw`[$_\p{ID_Start}]`;
const identifierContinueSource = String.raw`[$_\p{ID_Continue}\u200C\u200D]`;
const identifierSource = identifierStartSource + identifierContinueSource + '*';
const identifierStart = new RegExp(identifierStartSource, 'u');
const identifierContinue = new RegExp(identifierContinueSource, 'u');
const identifierPattern = new RegExp('^' + identifierSource, 'u');
// NumericLiteral is atomic in expressions and in property/method heads alike.
// Separators belong between digits; only integer forms permit a BigInt suffix.
const decimalDigitsSource = String.raw`[0-9](?:_?[0-9])*`;
const decimalIntegerSource = String.raw`(?:0|[1-9](?:_?[0-9])*)`;
const exponentSource = String.raw`[eE][+-]?${decimalDigitsSource}`;
const decimalTailSource = String.raw`(?:\.(?:${decimalDigitsSource})?)?(?:${exponentSource})?`;
const numericLiteralPattern = new RegExp('^(?:' + [
  String.raw`0[xX][0-9a-fA-F](?:_?[0-9a-fA-F])*n?`,
  String.raw`0[oO][0-7](?:_?[0-7])*n?`,
  String.raw`0[bB][01](?:_?[01])*n?`,
  decimalIntegerSource + 'n',
  // Annex B script literals retain their legacy, separator-free digit forms.
  String.raw`0[0-7]*[89][0-9]*(?:\.[0-9]*)?(?:${exponentSource})?`,
  String.raw`0[0-7]+`,
  decimalIntegerSource + decimalTailSource,
  String.raw`\.${decimalDigitsSource}(?:${exponentSource})?`,
].join('|') + ')', 'u');
const network = new RegExp(String.raw`https?:\/\/|(?<!${identifierContinueSource})(?:XMLHttpRequest|WebSocket|net\s*(?:\?\.|\.)\s*connect|https\s*(?:\?\.|\.)\s*request)(?!${identifierContinueSource})`, 'iu');
const apiNames = new Set(['fetch', 'XMLHttpRequest', 'WebSocket']);
const hostNames = new Set(['globalThis', 'window', 'self', 'global', 'net', 'https']);
const indirectNames = new Set(['call', 'apply', 'bind']);
const downloads = /\bnpm\s+install\b|\bcurl\b|\bdownload\w*\b/iu;
const telemetry = /(?:https?:\/\/[^\s"'`<>]*(?:sentry|mixpanel|segment|posthog|google-analytics)|(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)["'][^"']*(?:sentry|mixpanel|segment|posthog|google-analytics))/iu;

// ECMAScript LineTerminator characters, shared by comments, trivia and ASI.
const lineTerminatorCharacters = String.raw`\r\n\u2028\u2029`;
const lineTerminator = new RegExp(`[${lineTerminatorCharacters}]`, 'u');
function lineCommentLength(code, pos, scriptGoal, lineStart) {
  if (code.startsWith('//', pos)) return 2;
  if (scriptGoal && code.startsWith('<!--', pos)) return 4;
  if (scriptGoal && lineStart && code.startsWith('-->', pos)) return 3;
  return 0;
}

// Lookaheads must consume the same trivia as the lexical walk. In particular,
// an Annex B comment can separate a name from its colon or a call/member tail.
function skipJSTrivia(code, pos, end, scriptGoal, lineStart) {
  while (pos < end) {
    const begin = pos;
    const length = lineCommentLength(code, pos, scriptGoal, lineStart);
    if (/\s/u.test(code[pos])) {
      while (pos < end && /\s/u.test(code[pos])) pos++;
    } else if (length) {
      pos += length;
      while (pos < end && !lineTerminator.test(code[pos])) pos++;
    } else if (code.startsWith('/*', pos)) {
      const close = code.indexOf('*/', pos + 2);
      if (close < 0 || close + 2 > end) return pos;
      pos = close + 2;
    } else break;
    lineStart ||= lineTerminator.test(code.slice(begin, pos));
  }
  return pos;
}

function stringLeaves(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringLeaves);
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => [key, ...stringLeaves(item)]);
  }
  return [];
}

// Shared lexical walk for every expression split and group match. Literals
// and comments are atomic; depth describes the surrounding balanced groups.
// A slash starts a regex when the previous significant token cannot end an
// expression. Regex escapes and character classes protect embedded slashes.
const lexicalSources = new Map();
function hasModuleEvidence(tokens, code, declarations = true) {
  const significant = tokens.filter(token => !['trivia', 'comment'].includes(token.kind));
  return significant.some((token, index) => {
    // Unlike declarations, import.meta is module evidence at any depth,
    // including inside a function or a template interpolation.
    if (token.kind === 'word' && !token.identifierName) {
      if (token.text === 'import' && significant[index + 1]?.text === '.' &&
        significant[index + 2]?.text === 'meta') return true;
      if (declarations && token.depth === 0 && (token.text === 'export' ||
        (token.text === 'import' && !['(', '.'].includes(significant[index + 1]?.text)))) return true;
    }
    return token.interpolations.some(span => hasModuleEvidence(
      [...scanJSTokens(code, span.start, span.end, span.context)], code, false));
  });
}

function parsesAsScript(code) {
  // Compilation never executes the source. A valid script must retain its
  // goal even if a speculative module walk exposes words inside a regex.
  try { new vm.Script(code); return true; } catch {}
  // CommonJS also permits a top-level return/new.target. Its function body
  // grammar still rejects module declarations; remove only the hashbang.
  try { vm.compileFunction(code.replace(/^#![^\r\n\u2028\u2029]*/u, '')); return true; } catch {}
  return false;
}

function* scanJS(code, start = 0, end = code.length, context) {
  // Determine the source goal from executable module evidence, never from
  // text inside comments/strings. Reuse the enclosing context for fragment
  // scans; starting an expression in an async body must not turn await into a
  // name (or expose assignments inside an awaited regular expression).
  if (!context || context.sourceType) {
    // Expression analysis revisits many spans of the same source. Bound the
    // cache so those visits share a lexical walk without retaining all files.
    const key = (context?.sourceType || 'auto') + '\0' + code;
    let source = lexicalSources.get(key);
    if (!source) {
      const moduleGoal = context?.sourceType === 'module';
      source = [...scanJSTokens(code, 0, code.length, { await: moduleGoal, yield: false, module: moduleGoal })];
      if (!context?.sourceType) {
        // Probe the module goal independently: a script-goal await followed
        // by / can otherwise swallow the very declaration we need to find.
        const moduleSource = [...scanJSTokens(code, 0, code.length, { await: true, yield: false, module: true })];
        if (hasModuleEvidence(moduleSource, code) && !parsesAsScript(code)) source = moduleSource;
      }
      if (lexicalSources.size >= 32) lexicalSources.delete(lexicalSources.keys().next().value);
      lexicalSources.set(key, source);
    }
    if (start === 0 && end === code.length) { yield* source; return; }
    let token = source.find(token => token.end > start);
    for (let inner; (inner = token?.interpolations.find(span => span.start <= start && start < span.end));) {
      token = [...scanJS(code, inner.start, inner.end, inner.context)].find(next => next.end > start);
    }
    context = token?.context || source.at(-1)?.context || { await: false, yield: false };
    if (token && ['trivia', 'comment'].includes(token.kind) && lineTerminator.test(code.slice(token.start, start))) {
      context = { ...context, lineStart: true };
    }
  }
  yield* scanJSTokens(code, start, end, context);
}

function* scanJSTokens(code, start, end, context) {
  // Annex B depends on the source goal, independently of a function's Await
  // and Yield flags. Fragment contexts also retain the physical line state.
  const moduleGoal = Boolean(context.module);
  let lineStart = context.lineStart ?? start === 0;
  const stack = [];
  const closes = { '(': ')', '[': ']', '{': '}' };
  const controlHeads = new Set(['if', 'for', 'while', 'with', 'catch', 'switch']);
  const prefixWords = new Set(['return', 'throw', 'case', 'delete', 'void', 'typeof',
    'new', 'in', 'instanceof', 'else', 'do']);
  let canEnd = false;
  let previous;
  let previousControl = false;
  let statementPosition = !context.expression;
  let lineBreak = false;
  let pendingStatementEnd = false;
  let pendingForHead = false;
  let pendingFunction = false;
  let previousFunctionClose = false;
  let previousFunctionExpression = false;
  let previousFunctionConstruct = false;
  let declarationPrefix = false;
  const pendingClasses = [];
  const questions = [];
  const history = [];
  const arrows = [];
  let previousOperator = false;
  let previousHead;
  const memberHead = owner => history.slice(owner.memberStart).filter(token => token.depth === stack.length);
  // A newline can terminate a field only after its name or a complete
  // initializer. Inspect direct-member tokens so nested groups stay atomic.
  const classFieldASI = (char, pos) => {
    const owner = stack.at(-1);
    if (!owner?.classBody || !lineBreak) return false;
    const head = memberHead(owner);
    let index = 0;
    if (head[0]?.text === 'static' && head[1]?.text !== '=') {
      // A line break is allowed after the static modifier.
      if (head.length === 1) return false;
      index++;
    }
    const name = head[index];
    if (!name) return false;
    if (name.text === '#' && head[index + 1]?.kind === 'word') index += 2;
    else if (name.text === '[' && head[index + 1]?.text === ']') index += 2;
    else if (['word', 'string', 'number'].includes(name.kind)) index++;
    else return false;
    const word = identifierStart.test(char) ? code.slice(pos).match(identifierPattern)?.[0] : undefined;
    const startsNumber = /[0-9]/u.test(char) || (char === '.' && /[0-9]/u.test(code[pos + 1] || ''));
    const startsName = word !== undefined || char === '#' || char === '[' || /["']/u.test(char) || startsNumber;
    if (index === head.length) {
      // Accessor prefixes permit a newline; async does not. A star after a
      // bare field starts a generator, while '(' still starts its parameters.
      if (['get', 'set'].includes(name.text) && startsName) return false;
      return startsName || char === '*';
    }
    // Operators, calls, member access and tagged templates continue an
    // initializer across a newline. In particular, '*' is multiplication.
    return canEnd && head[index]?.text === '=' && index + 1 < head.length &&
      ((word !== undefined && !['in', 'instanceof'].includes(word)) || char === '#' || /["']/u.test(char) || startsNumber);
  };
  // The direct member head, with balanced computed names kept atomic. This
  // distinguishes async/* modifiers from methods actually named async/yield.
  const methodContext = () => {
    const owner = stack.at(-1);
    if (!owner || !(owner.braceKind === 'object' || owner.classBody)) return;
    const head = memberHead(owner);
    const names = head.map(token => token.text);
    if (owner.classBody && names[0] === 'static' && names.length > 1) names.shift();
    if (names.at(-1) === ']') {
      const opening = names.indexOf('[');
      if (opening >= 0) names.splice(opening, names.length - opening, 'name');
    }
    // PrivateIdentifier is one name, not a method modifier. Keep the same
    // modifier grammar as public methods, including static and accessors.
    if (owner.classBody && names.at(-2) === '#' && head.at(-1)?.kind === 'word') names.splice(-2, 1);
    const name = names.pop();
    if (!name || !['', 'async', '*', 'async,*', 'get', 'set'].includes(names.join(','))) return;
    const modifier = head.findIndex(token => token.text === 'async');
    if (names.includes('async') && lineTerminator.test(code.slice(head[modifier].end, head[modifier + 1]?.start))) return;
    return { await: names.includes('async'), yield: names.includes('*') };
  };
  for (let pos = start; pos < end;) {
    const begin = pos;
    const char = String.fromCodePoint(code.codePointAt(pos));
    const commentLength = lineCommentLength(code, pos, !moduleGoal, lineStart);
    if (!commentLength && classFieldASI(char, pos)) {
      stack.at(-1).memberStart = history.length;
      stack.at(-1).propertyName = true;
      // A field named class must not leak a speculative class head.
      if (pendingClasses.at(-1)?.depth === stack.length) pendingClasses.pop();
    }
    // A concise arrow ends at its surrounding expression delimiter. Nested
    // groups and conditional middle branches retain the arrow's context.
    const arrowASI = !commentLength && lineBreak && canEnd && (char === '{' || code.startsWith('++', pos) ||
      code.startsWith('--', pos) || (identifierStart.test(char) &&
        !['in', 'instanceof'].includes(code.slice(pos).match(identifierPattern)?.[0])));
    if (',;)]}:'.includes(char) || arrowASI) {
      while (arrows.length && (stack.length < arrows.at(-1).depth ||
        (stack.length === arrows.at(-1).depth &&
          (char !== ':' || questions.length <= arrows.at(-1).questions)))) {
        context = arrows.pop().outer;
      }
    }
    const tokenContext = { ...context, module: moduleGoal, lineStart };
    const couldEnd = canEnd;
    // Complete debugger statements and restricted break/continue productions
    // (including labels) end at a line terminator, even inside a comment.
    // Reset the lexical goal before deciding whether a slash opens a regex.
    if (lineBreak && pendingStatementEnd) canEnd = false;
    // Decide ASI in the surrounding statement context before an opening
    // group changes the stack. Restricted productions also end at a newline,
    // including break/continue with an optional same-line label.
    const afterASI = lineBreak && (couldEnd || pendingStatementEnd || previous === 'return' ||
      (previous === 'yield' && previousOperator)) &&
      (!stack.length || stack.at(-1)?.braceKind === 'block');
    let kind = 'punctuation';
    let valid = true;
    let dynamic = false;
    const interpolations = [];
    let unmatched = false;
    let braceKind;
    let functionBody = false;
    let functionClose = false;
    let functionExpression = false;
    let functionConstruct = false;
    let expressionBody = false;
    let classBody = false;
    let expressionColon = false;
    let controlClose = false;
    let identifierName = false;
    let contextualOperator = false;
    let headContext;
    if (pos === 0 && code.startsWith('#!', pos)) {
      // HashbangGrammar applies only at the start of the complete source.
      // Match the same terminators as the compile-check hashbang removal.
      kind = 'comment';
      pos += 2;
      while (pos < end && !lineTerminator.test(code[pos])) pos++;
    } else if (/\s/u.test(char)) {
      kind = 'trivia';
      while (pos < end && /\s/u.test(code[pos])) pos++;
    } else if (commentLength) {
      kind = 'comment';
      pos += commentLength;
      while (pos < end && !lineTerminator.test(code[pos])) pos++;
    } else if (code.startsWith('/*', pos)) {
      kind = 'comment';
      const close = code.indexOf('*/', pos + 2);
      valid = close >= 0 && close + 2 <= end;
      pos = valid ? close + 2 : end;
    } else if ('"\'`'.includes(char)) {
      kind = char === '`' ? 'template' : 'string';
      valid = false;
      for (pos++; pos < end; pos++) {
        if (code[pos] === '\\') { pos++; continue; }
        if (code[pos] === char) { pos++; valid = true; break; }
        if (char !== '`' || !code.startsWith('${', pos)) continue;
        dynamic = true;
        let close;
        const innerContext = { ...context, module: moduleGoal, lineStart: false, expression: true };
        for (const inner of scanJS(code, pos + 2, end, innerContext)) {
          if (inner.text === '}' && inner.unmatched) { close = inner.start; break; }
          if (!inner.valid) break;
        }
        if (close === undefined) { pos = end; break; }
        const interpolation = { start: pos + 2, end: close };
        Object.defineProperty(interpolation, 'context', { value: innerContext });
        interpolations.push(interpolation);
        pos = close;
      }
      canEnd = true;
    } else if (char === '/' && !canEnd) {
      kind = 'regex';
      let inClass = false;
      valid = false;
      for (pos++; pos < end; pos++) {
        if (lineTerminator.test(code[pos])) break;
        if (code[pos] === '\\') { pos++; continue; }
        if (code[pos] === '[') inClass = true;
        else if (code[pos] === ']') inClass = false;
        else if (code[pos] === '/' && !inClass) {
          pos++;
          // Regex flags have the same IdentifierPart character grammar.
          while (pos < end && identifierContinue.test(String.fromCodePoint(code.codePointAt(pos)))) {
            pos += code.codePointAt(pos) > 0xffff ? 2 : 1;
          }
          valid = true;
          break;
        }
      }
      canEnd = true;
    } else if (identifierStart.test(char)) {
      kind = 'word';
      pos += code.slice(pos, end).match(identifierPattern)[0].length;
      // IdentifierName accepts every keyword in member/property positions.
      // Keep object/class name slots through static/async/get/set/generator prefixes;
      // its colon or parameter opener ends that slot, before values/bodies.
      const afterName = skipJSTrivia(code, pos, end, !moduleGoal, false);
      identifierName = previous === '.' || previous === '?.' || previous === '#' ||
        Boolean(stack.at(-1)?.propertyName) ||
        (afterName < end && code[afterName] === ':');
      const word = code.slice(begin, pos);
      contextualOperator = !identifierName &&
        ((word === 'await' && context.await) || (word === 'yield' && context.yield));
      // `of` requires an iterable only at the direct for-head separator.
      // Elsewhere it is an identifier, including the binding in `of of xs`,
      // member names, nested expressions and the iterable's own first word.
      const forHead = stack.at(-1);
      const afterDeclaration = !history.at(-1)?.identifierName && ['var', 'let', 'const'].includes(previous);
      const iterableSeparator = !identifierName && word === 'of' &&
        forHead?.forPhase === 'init' && canEnd && !afterDeclaration;
      if (iterableSeparator || (!identifierName && word === 'in' && forHead?.forPhase === 'init')) {
        forHead.forPhase = 'iterable';
      }
      canEnd = identifierName || (!prefixWords.has(word) && !contextualOperator && !iterableSeparator);
    } else if (/[0-9]/u.test(char) || (char === '.' && pos + 1 < end && /[0-9]/u.test(code[pos + 1]))) {
      kind = 'number';
      pos += code.slice(pos, end).match(numericLiteralPattern)[0].length;
      canEnd = true;
    } else {
      // OptionalChainingPunctuator cannot consume a leading-dot fraction.
      const operator = code.slice(pos, end).match(/^(?:\.\.\.|\?\?=?|\?\.(?![0-9])|\+\+|--|===?|!==?|=>|&&=?|\|\|=?|\*\*=?|<<=?|>>>=?|>>=?|[+*/%&|^!<>=-]=)/u)?.[0];
      pos += operator?.length || 1;
      if (char === '{') {
        const classHead = pendingClasses.at(-1);
        // Heritage can end in a call/group too; its ')' is not a method's
        // parameter list. An actual function in heritage still owns its body.
        classBody = classHead?.depth === stack.length && previous !== '=>' &&
          !(previousFunctionClose && previousFunctionConstruct);
        functionBody = previous === '=>' || previousFunctionClose;
        // Carry the construct's original position through its name, heritage,
        // parameters and body. A completed expression produces an operand;
        // a declaration still permits a following regex-led statement.
        expressionBody = previous === '=>' ||
          (previousFunctionClose && previousFunctionExpression) ||
          (classBody && classHead.expression);
        if (classBody) pendingClasses.pop();
        // The same operand/statement state that chooses regex versus division
        // chooses object versus block. This covers every operand position:
        // keyword/operator operands, for-head clauses, arguments, elements,
        // values and defaults. Labels/control bodies remain statements; ASI
        // and function/class/arrow bodies take precedence over expressions.
        const objectContext = !canEnd && !statementPosition;
        braceKind = !functionBody && !classBody && !afterASI && objectContext ? 'object' : 'block';
      }
      if (Object.hasOwn(closes, char)) {
        if (char === '(') {
          headContext = pendingFunction ? { await: pendingFunction.async, yield: pendingFunction.generator } : methodContext();
        } else if (classBody) {
          // Field initializers/static blocks do not inherit Await/Yield from
          // the function containing the class. Each method sets its own flags.
          headContext = { await: false, yield: false };
        } else if (functionBody) {
          headContext = previous === '=>' ? previousHead : previousHead?.body;
          headContext ||= { await: false, yield: false };
        }
        // A method named class has a parameter list, not a class body.
        if (char === '(' && previous === 'class' && pendingClasses.at(-1)?.depth === stack.length) pendingClasses.pop();
        if (stack.at(-1)?.propertyName) stack.at(-1).propertyName = false;
        stack.push({ close: closes[char], braceKind, functionBody, expressionBody, classBody,
          memberStart: history.length + 1,
          outerContext: context, bodyContext: headContext,
          asyncArrow: char === '(' && previous === 'async' && !lineBreak,
          functionExpression: char === '(' && Boolean(pendingFunction?.expression),
          functionConstruct: char === '(' && Boolean(pendingFunction),
          propertyName: braceKind === 'object' || classBody,
          control: char === '(' && (previousControl || pendingForHead),
          forPhase: char === '(' && pendingForHead ? 'init' : undefined,
          // A non-control parameter-list shape also covers object/class
          // methods, including get/set/async/static prefixes.
          functionHead: char === '(' && !pendingForHead && (Boolean(pendingFunction) || !previousControl) });
        if (headContext) context = { ...(char === '(' ? { await: false, yield: false } : headContext), module: moduleGoal };
        if (char === '(') {
          pendingFunction = false;
          pendingForHead = false;
        }
      }
      else if (')]}'.includes(char)) {
        unmatched = stack.length === 0;
        const opener = stack.pop();
        valid = opener?.close === char;
        controlClose = char === ')' && opener?.control;
        functionClose = char === ')' && opener?.functionHead;
        functionExpression = char === ')' && opener?.functionExpression;
        functionConstruct = char === ')' && opener?.functionConstruct;
        if (opener?.bodyContext) context = opener.outerContext;
        if (char === ')') headContext = { body: opener?.bodyContext,
          await: Boolean(opener?.asyncArrow), yield: false };
        braceKind = opener?.braceKind;
        functionBody = opener?.functionBody || false;
        expressionBody = opener?.expressionBody || false;
        while (questions.at(-1) > stack.length) questions.pop();
      }
      if (operator === undefined && char === '?') questions.push(stack.length);
      if (char === ':') {
        const ternary = questions.at(-1) === stack.length;
        if (ternary) questions.pop();
        expressionColon = ternary || stack.at(-1)?.braceKind === 'object' || stack.at(-1)?.close === ')';
      }
      if (char === ';' && stack.at(-1)?.forPhase) stack.at(-1).forPhase = 'clause';
      // Control heads and blocks allow a regex statement. Expression parens
      // and object literals end an operand and leave / as division.
      canEnd = !controlClose && !(char === '}' && braceKind === 'block' && !expressionBody) &&
        (')]}'.includes(char) || operator === '++' || operator === '--');
      if (operator === '=>') {
        headContext = previous === ')' ? previousHead : {
          await: history.at(-2)?.text === 'async' &&
            !lineTerminator.test(code.slice(history.at(-2).end, begin)), yield: false };
        headContext ||= { await: false, yield: false };
        if (code[skipJSTrivia(code, pos, end, !moduleGoal, false)] !== '{') {
          arrows.push({ depth: stack.length, questions: questions.length, outer: context });
          context = { ...headContext, module: moduleGoal };
        }
      }
    }
    const text = code.slice(begin, pos);
    const depth = stack.length - (Object.hasOwn(closes, text) ? 1 : 0);
    if (kind === 'trivia' || kind === 'comment') {
      lineBreak ||= lineTerminator.test(text);
      lineStart ||= lineTerminator.test(text);
    } else {
      lineStart = false;
      pendingStatementEnd = kind === 'word' && !identifierName &&
        (['debugger', 'break', 'continue'].includes(text) ||
          (pendingStatementEnd && !lineBreak && ['break', 'continue'].includes(previous)));
      previousControl = kind === 'word' && !identifierName &&
        (statementPosition || afterASI) && controlHeads.has(text);
      // Only a statement's for keyword can start this state. Trivia and one
      // optional await may intervene; every other significant token clears it.
      if (previousControl && text === 'for') pendingForHead = 'for';
      else if (pendingForHead === 'for' && text === 'await' && !identifierName) pendingForHead = 'await';
      else pendingForHead = false;
      if (kind === 'word' && text === 'function' && !identifierName) {
        pendingFunction = { stage: 'name', expression: !(statementPosition || afterASI || declarationPrefix),
          async: previous === 'async' && !lineBreak && !history.at(-1)?.identifierName, generator: false };
      } else if (pendingFunction?.stage === 'name' && kind === 'word') pendingFunction.stage = 'parameters';
      else if (pendingFunction?.stage === 'name' && text === '*') pendingFunction.generator = true;
      else pendingFunction = false;
      if (kind === 'word' && text === 'class' && !identifierName) {
        pendingClasses.push({ depth: stack.length, expression: !(statementPosition || afterASI || declarationPrefix) });
      } else if (['=', ';'].includes(text) && pendingClasses.at(-1)?.depth === stack.length) {
        // A class-named field/property cannot leave a pending class head.
        pendingClasses.pop();
      }
      declarationPrefix = kind === 'word' && !identifierName && ['async', 'export', 'default'].includes(text) &&
        (statementPosition || afterASI || declarationPrefix);
      previousFunctionClose = functionClose;
      previousFunctionExpression = functionExpression;
      previousFunctionConstruct = functionConstruct;
      previousHead = headContext;
      if (stack.at(-1)?.braceKind === 'object') {
        if (text === ',') stack.at(-1).propertyName = true;
        else if ([':', '=', '...'].includes(text)) stack.at(-1).propertyName = false;
      }
      if (stack.at(-1)?.classBody && text === '=') stack.at(-1).propertyName = false;
      // An object/arrow/function/class initializer's closing brace does not
      // finish the field; it may still have a call, member or operator tail.
      if ((stack.at(-1)?.braceKind === 'object' && text === ',') ||
          (stack.at(-1)?.classBody && (text === ';' ||
            (text === '}' && !memberHead(stack.at(-1)).some(token => token.text === '='))))) {
        stack.at(-1).memberStart = history.length + 1;
        // The next member's keywords are names too, for both construct
        // trackers. Initializers and parameter/body openers end this slot.
        stack.at(-1).propertyName = true;
      }
      statementPosition = (text === '{' && braceKind === 'block') || controlClose ||
        (text === '}' && braceKind === 'block' && !expressionBody) ||
        (text === ';' && stack.at(-1)?.close !== ')') ||
        (text === ':' && !expressionColon) ||
        (kind === 'word' && !identifierName && ['else', 'do'].includes(text));
      previous = text;
      previousOperator = contextualOperator;
      lineBreak = false;
    }
    const token = { start: begin, end: pos, text, kind, valid, dynamic, interpolations, unmatched, depth, canEnd,
      braceKind, functionBody, identifierName };
    // Internal lexical context travels with fragments without changing the
    // public token shape used by the earlier parity checks.
    Object.defineProperty(token, 'context', { value: tokenContext });
    if (kind !== 'trivia' && kind !== 'comment') history.push(token);
    yield token;
    if (!valid) return;
  }
}

// Expression splitting keeps templates atomic. Binding/call span maps instead
// expose interpolation code recursively, with only literal text excluded.
function* codeSpans(code, start = 0, end = code.length, depth = 0, context) {
  for (const token of scanJS(code, start, end, context)) {
    if (!token.interpolations.length) {
      yield { ...token, depth: token.depth + depth };
      continue;
    }
    let from = token.start;
    const level = token.depth + depth;
    for (const inner of token.interpolations) {
      yield { ...token, start: from, end: inner.start - 1,
        text: code.slice(from, inner.start - 1), valid: true, depth: level };
      yield { start: inner.start - 1, end: inner.start, text: '{',
        kind: 'punctuation', valid: true, depth: level, canEnd: false };
      yield* codeSpans(code, inner.start, inner.end, level + 1, inner.context);
      yield { start: inner.end, end: inner.end + 1, text: '}',
        kind: 'punctuation', valid: true, depth: level, canEnd: true };
      from = inner.end + 1;
    }
    yield { ...token, start: from, text: code.slice(from, token.end), depth: level };
  }
}

// Preserve all atomic literals while replacing comments with one space, so
// comments cannot split a call. Raw analysis is retained in every case.
function stripJSComments(code, context) {
  let result = '';
  for (const token of codeSpans(code, 0, code.length, 0, context)) {
    result += token.kind === 'comment' ? ' ' : token.text;
    if (!token.valid) result += code.slice(token.end);
  }
  return result;
}

function normalizeJSMembers(code) {
  return code.replace(new RegExp('(' + identifierContinueSource + ')\\s+\\.\\s*(?=' + identifierContinueSource + ')', 'gu'), '$1.')
    .replace(new RegExp('(' + identifierContinueSource + ')\\s*\\.\\s+(?=' + identifierContinueSource + ')', 'gu'), '$1.');
}

function decodeJSEscapes(code) {
  const simple = { '\\': '\\', '/': '/', n: '\n', t: '\t', r: '\r',
    b: '\b', f: '\f', v: '\v', 0: '\0', "'": "'", '"': '"' };
  let decoded = '';
  for (let i = 0; i < code.length; i++) {
    if (code[i] !== '\\' || i + 1 === code.length) {
      decoded += code[i];
      continue;
    }
    const char = code[++i];
    if (lineTerminator.test(char)) {
      if (char === '\r' && code[i + 1] === '\n') i++;
      continue;
    }
    if (char === 'x' || char === 'u') {
      const hex = code.slice(i + 1).match(char === 'x' ? /^[\da-fA-F]{2}/u :
        /^(?:[\da-fA-F]{4}|\{[\da-fA-F]+\})/u);
      if (hex) {
        const point = Number.parseInt(hex[0].replace(/[{}]/gu, ''), 16);
        decoded += point <= 0x10ffff ? String.fromCodePoint(point) : '\\' + char + hex[0];
        i += hex[0].length;
        continue;
      }
    }
    // Consume each escape once: an escaped backslash cannot start another
    // escape in this pass. Non-special escapes are JavaScript identity escapes.
    decoded += simple[char] ?? char;
  }
  return decoded;
}

function foldJSStrings(code) {
  const literal = /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`/u.source;
  const concatenation = new RegExp('(' + literal + ')\\s*\\+\\s*(' + literal + ')', 'gu');
  for (;;) {
    const folded = code.replace(concatenation, (match, left, right) => {
      if ([left, right].some((value) => value.startsWith('`') && value.includes('${'))) return match;
      return JSON.stringify(decodeJSEscapes(left.slice(1, -1)) + decodeJSEscapes(right.slice(1, -1)));
    });
    if (folded === code) return code;
    code = folded;
  }
}

function analysisVariants(code, sourceType) {
  const context = sourceType ? { sourceType } : undefined;
  const stripped = stripJSComments(code, context);
  const decoded = decodeJSEscapes(code);
  // Every detector sees every view. Transformations can only add findings.
  const variants = [code, decoded, stripped, decodeJSEscapes(stripped), stripJSComments(decoded, context)];
  return [...new Set(variants.flatMap((variant) => {
    const folded = foldJSStrings(variant);
    return [variant, normalizeJSMembers(variant), folded, normalizeJSMembers(folded)];
  }))];
}

function literalDestination(argument) {
  const quote = argument[0];
  if (!quote || !'"\'`'.includes(quote)) return false;
  let value = '';
  let end = 0;
  for (let i = 1; i < argument.length; i++) {
    const char = argument[i];
    if (char === quote) { end = i + 1; break; }
    if (quote === '`' && char === '$' && argument[i + 1] === '{') return false;
    if (char !== '\\') {
      // ES2019 permits raw LS/PS in quoted strings, unlike raw CR/LF.
      if (quote !== '`' && lineTerminator.test(char) && !['\u2028', '\u2029'].includes(char)) return false;
      value += char;
      continue;
    }
    const escape = argument[++i];
    if (escape === undefined) return false;
    if (lineTerminator.test(escape)) {
      if (escape === '\r' && argument[i + 1] === '\n') i++;
      continue;
    }
    if (escape === 'x' || escape === 'u') {
      const rest = argument.slice(i + 1);
      const hex = escape === 'x' ? rest.match(/^[a-f0-9]{2}/iu) :
        rest.match(/^(?:[a-f0-9]{4}|\{[a-f0-9]+\})/iu);
      if (!hex) return false;
      const point = Number.parseInt(hex[0].replace(/[{}]/gu, ''), 16);
      if (point > 0x10ffff) return false;
      value += String.fromCodePoint(point);
      i += hex[0].length;
    } else {
      // Legacy octal escapes are deliberately not accepted as static URLs.
      if (/[0-9]/u.test(escape)) return false;
      value += ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v' })[escape] ?? escape;
    }
  }
  // The literal must be the entire destination argument, not a concatenation,
  // property access, tagged template, or another expression with a URL prefix.
  if (!end || argument.slice(end).trim() ||
      !/^https?:\/\//iu.test(value) || /\s|[\u0000-\u001f]/u.test(value)) return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && Boolean(url.hostname);
  } catch { return false; }
}

// Start just after a call/group opener. Only commas at that depth split
// segments; nested calls/objects/arrays and quoted delimiters stay intact.
function callArguments(tail, withBounds = false, closing = ')', context) {
  let questions = 0;
  const args = [];
  const bounds = [];
  let start = 0;
  for (const token of scanJS(tail, 0, tail.length, context)) {
    const { text: char, start: i, depth, valid } = token;
    if (!valid) {
      if (token.unmatched && char === closing) {
        args.push(tail.slice(start, i).trim());
        bounds.push({ start, end: i });
        return withBounds ? { args, bounds, lastStart: start, closing: i } : args;
      }
      return null;
    }
    if (depth !== 0) continue;
    if (char === '?') questions++;
    else if (char === ':' && questions) questions--;
    // A comma in a conditional's middle branch belongs to that expression.
    else if (char === ',' && !questions) {
      args.push(tail.slice(start, i).trim());
      bounds.push({ start, end: i });
      start = i + 1;
    }
  }
  return null;
}

// A small callee-expression scan, shared by presence and destination checks.
// Members keep their effective names regardless of dot/bracket spelling.
// Trivia is recognized here too: shell command strings may contain JS comments
// that the whole-source comment stripper correctly leaves inside strings.
function networkCalls(code, sourceType) {
  const calls = [];
  const context = sourceType ? { sourceType } : undefined;
  const scan = (start = 0, end = code.length) => scanJS(code, start, end, context);
  const argumentsAt = (start, withBounds = false, closing = ')') =>
    callArguments(code.slice(start), withBounds, closing,
      scan(start).next().value?.context);
  const roots = new RegExp(identifierSource + '|\\(', 'gu');
  const trivia = (pos) => {
    const lexical = scan(pos).next().value?.context;
    return skipJSTrivia(code, pos, code.length, !lexical?.module, lexical?.lineStart ?? pos === 0);
  };
  // Read a quoted member, keeping interpolated templates dynamic. Nested
  // expressions/templates must not let an inner backtick terminate the member.
  const quoted = (start) => {
    const token = scan(start).next().value;
    return token?.valid && ['string', 'template'].includes(token.kind) ? token : null;
  };
  // Lexical blocks and for heads shadow aliases; var belongs to a function,
  // static block or top level. Assignments update the nearest visible binding.
  const scopes = [{ bindings: new Map(), kind: 'function' }];
  const mayWrites = new Map([[scopes[0].bindings, new Map()]]);
  let resolvingDeferred = false;
  const bindingScope = (name) => {
    for (let i = scopes.length - 1; i >= 0; i--) {
      if (scopes[i].bindings.has(name)) return scopes[i].bindings;
    }
  };
  const declarationScope = (kind) => kind === 'var'
    ? scopes.findLast((scope) => ['function', 'static'].includes(scope.kind)).bindings : scopes.at(-1).bindings;
  const crossesDeferredScope = (bindings) => {
    let staticClass = false;
    for (let i = scopes.length - 1; i >= 0; i--) {
      if (scopes[i].bindings === bindings) return false;
      if (scopes[i].kind === 'function') return true;
      if (scopes[i].kind === 'static') staticClass = true;
      if (scopes[i].kind === 'class') {
        if (!staticClass) return true;
        staticClass = false;
      }
    }
    return false;
  };
  const alias = (name) => {
    const scope = bindingScope(name);
    const value = scope?.get(name);
    return resolvingDeferred && mayWrites.get(scope)?.has(name)
      ? union([value, mayWrites.get(scope).get(name)], value?.end) : value;
  };
  const assignmentOperators = new Set(['=', '||=', '&&=', '??=']);
  const knownPath = (names) => names.some((name, i) => apiNames.has(name) ||
    (name === 'connect' && names[i - 1] === 'net') ||
    (name === 'request' && names[i - 1] === 'https'));
  const known = (value) => value?.paths?.some(knownPath);
  const member = (pos, resolveAliases) => {
    let next = trivia(pos);
    const optional = code.startsWith('?.', next);
    if (optional) next = trivia(next + 2);
    const dot = code[next] === '.';
    if (dot) next = trivia(next + 1);
    if (code[next] === '[' && !dot) {
      const value = expression(next + 1, ']', resolveAliases);
      if (value?.candidates) return value;
    }
    if (!optional && !dot) return null;
    const name = code.slice(next).match(identifierPattern)?.[0];
    // Retain FIX9's conservative optional-dot indirection tail as well.
    if (!name || (optional && dot && !indirectNames.has(name))) return null;
    return { candidates: new Set([name]), end: next + name.length };
  };
  // Find the outer conditional in a bounded expression. Atomic spans and
  // balanced groups are opaque; nested ternaries pair their own colons.
  // Optional chaining and nullish operators are not conditional delimiters.
  const conditional = (start, end) => {
    let question;
    let depth = 0;
    for (const token of scan(start, end)) {
      if (!token.valid) return null;
      if (token.depth !== 0) continue;
      if (token.text === '?') {
        question ??= token.start;
        depth++;
      } else if (token.text === ':' && depth && --depth === 0) return { question, colon: token.start };
    }
    return null;
  };
  const union = (values, end) => ({
    candidates: new Set(values.flatMap((value) => [...(value?.candidates || [])])),
    paths: values.flatMap((value) => value?.paths || []),
    dynamic: values.some((value) => !value?.candidates || value.dynamic),
    dynamicMember: values.some((value) => value?.dynamicMember),
    end,
  });
  // One evaluator serves callee references AND bracket contents: literals,
  // concatenations, parentheses, comma sequences (last segment wins),
  // assignments and conditionals/logicals. Candidate sets retain each operand.
  // Balanced groups use the same depth-aware split, recursively, in both roles.
  const expression = (start, closing, resolveAliases = true, end) => {
    if (closing) {
      const group = argumentsAt(start, true, closing);
      if (!group) return null;
      const value = expression(start, undefined, resolveAliases, start + group.closing);
      if (!value || trivia(value.end) !== start + group.closing) return null;
      return { ...value, end: start + group.closing + 1 };
    }
    if (end !== undefined) {
      const sequence = callArguments(code.slice(start, end) + ')', true, ')', scan(start).next().value?.context);
      if (!sequence || sequence.closing !== end - start) return null;
      if (sequence.lastStart) return expression(start + sequence.lastStart, undefined, resolveAliases, end);
    }
    // Plain assignment replaces the value. Logical assignment can retain
    // the identifier's existing value, so both sides contribute candidates.
    const head = scan(start, end);
    const significant = () => {
      for (let next = head.next(); !next.done; next = head.next()) {
        const token = next.value;
        if (!['trivia', 'comment'].includes(token.kind)) return token;
      }
    };
    const identifier = significant();
    if (identifier?.kind === 'word' && identifier.valid && identifier.depth === 0) {
      const operator = significant();
      if (operator?.valid && operator.depth === 0 && assignmentOperators.has(operator.text)) {
        const right = expression(operator.end, undefined, resolveAliases, end);
        if (operator.text === '=') return right;
        const left = alias(identifier.text) || { paths: [[identifier.text]] };
        return union([left, right], right?.end ?? end ?? operator.end);
      }
    }
    const split = end === undefined ? null : conditional(start, end);
    if (split && trivia(start) < split.question) {
      const branch = (from, to) => {
        const value = expression(from, undefined, resolveAliases, to);
        return value && trivia(value.end) === to ? value : null;
      };
      const left = branch(split.question + 1, split.colon);
      const right = branch(split.colon + 1, end);
      return union([left, right], end);
    }
    if (end !== undefined) {
      const operands = [];
      let from = start;
      for (const token of scan(start, end)) {
        if (!token.valid) return null;
        if (token.depth !== 0 || !['||', '&&', '??'].includes(token.text)) continue;
        operands.push([from, token.start]);
        from = token.end;
      }
      if (operands.length) {
        operands.push([from, end]);
        return union(operands.map(([from, to]) => {
          const value = expression(from, undefined, resolveAliases, to);
          return value && trivia(value.end) === to ? value : null;
        }), end);
      }
    }
    const term = (start) => {
      const pos = trivia(start);
      let value;
      if (code[pos] === '(') value = expression(pos + 1, ')', resolveAliases);
      else if (code[pos] && '"\'`'.includes(code[pos])) {
        const token = quoted(pos);
        if (token) value = {
          candidates: new Set(token.dynamic ? [] : [decodeJSEscapes(code.slice(pos + 1, token.end - 1))]),
          dynamic: token.dynamic, end: token.end,
        };
      } else {
        const name = code.slice(pos).match(identifierPattern)?.[0];
        if (name) value = {
          ...(resolveAliases && alias(name) ? alias(name) : { paths: [[name]] }),
          end: pos + name.length,
        };
      }
      if (!value) return null;
      for (let part; (part = member(value.end, resolveAliases));) {
        const paths = value.paths || [];
        const dynamicMember = value.dynamicMember ||
          (part.dynamic && paths.some((names) => names.some((name) => apiNames.has(name) || hostNames.has(name))));
        value = {
          paths: paths.flatMap((names) => [...part.candidates].map((name) => [...names, name])),
          dynamicMember, end: part.end,
        };
      }
      return value;
    };
    let value = term(start);
    if (!value) return null;
    while (code[trivia(value.end)] === '+') {
      const right = term(trivia(value.end) + 1);
      if (!right || !value.candidates || !right.candidates) return null;
      const dynamic = value.dynamic || right.dynamic;
      value = {
        candidates: new Set([...value.candidates].flatMap((left) => [...right.candidates].map((right) => left + right))),
        dynamic, end: right.end,
      };
    }
    // Unbounded callee references use the same union rule, stopping where
    // their final operand stops. Extracted arguments use their complete spans.
    if (end === undefined) {
      const operator = scan(trivia(value.end)).next().value;
      if (operator?.valid && ['||', '&&', '??'].includes(operator.text)) {
        const right = expression(operator.end, undefined, resolveAliases);
        if (right) value = union([value, right], right.end);
      }
    }
    return value;
  };
  // Bound an assignment RHS before invoking the shared evaluator, including
  // its conditional/comma handling. Balanced groups and conditional middle
  // branches protect their commas; ASI does not swallow the next statement.
  const referenceEnd = (start) => {
    let previous;
    let lineBreak = false;
    let questions = 0;
    for (const token of scan(start)) {
      if (!token.valid || (token.depth === 0 &&
          (token.text === ';' || (token.text === ',' && !questions)))) return token.start;
      if (['trivia', 'comment'].includes(token.kind)) {
        lineBreak ||= lineTerminator.test(token.text);
        continue;
      }
      const startsTerm = (['word', 'number', 'string', 'template', 'regex'].includes(token.kind) &&
        !['in', 'instanceof'].includes(token.text)) || ['{', '!', '~', '++', '--'].includes(token.text);
      if (lineBreak && token.depth === 0 && !questions && previous?.canEnd && startsTerm) return token.start;
      if (token.depth === 0) {
        if (token.text === '?') questions++;
        else if (token.text === ':' && questions) questions--;
      }
      previous = token;
      lineBreak = false;
    }
    return code.length;
  };
  // Bounded may-analysis: direct NAME writes in conditional contexts or across
  // function/class boundaries UNION candidates; static blocks execute immediately.
  // Only unconditional writes in the same function flow replace candidates.
  // For-head conditions/updates are conditional. Calls in function parameters/bodies,
  // class field regions (except static blocks), loop bodies and repeated loop
  // heads resolve AFTER the walk, unioning their flow-sensitive candidates
  // with EVERY direct write to the SAME lexical binding in its enclosing
  // function scope (including later writes and nested blocks/functions/loops).
  // Shadowing declarations have separate binding maps and cannot contribute.
  // Straight-line calls, including for INIT, use only the candidates at their
  // source position. Repeated heads are for CONDITION/UPDATE and while/do-while
  // CONDITION; for-in/of source expressions are evaluated only once.
  // RHS calls, alias chains, destructuring and parameter passing remain
  // untracked. Every brace pair (including objects) is a lexical scope; var
  // belongs to the nearest function/static block. Replay writes and scope/conditional
  // events in source order, without evaluating conditions or running bodies.
  const tokens = [...codeSpans(code, 0, code.length, 0, context)];
  const atomicKinds = new Set(['string', 'template', 'regex', 'comment']);
  const events = tokens.filter((token) => token.kind === 'punctuation' &&
    ['{', '}'].includes(token.text)).map((token) => ({ start: token.start,
      scope: token.text === '{' ? 'open' : 'close', kind: token.functionBody ? 'function' : 'block' }));
  // Match groups once, using executable tokens (including interpolations).
  // Loop scopes begin before head bindings and end just after the body.
  const significant = tokens.filter((token) => !['trivia', 'comment'].includes(token.kind));
  const groupEnds = new Map();
  const groups = [];
  for (let i = 0; i < significant.length; i++) {
    const token = significant[i];
    if (token.kind !== 'punctuation') continue;
    if (['(', '[', '{'].includes(token.text)) groups.push(i);
    else if ([')', ']', '}'].includes(token.text) && groups.length) groupEnds.set(groups.pop(), i);
  }
  // Default initializers run when their function is called. The complete
  // parameter list is a function context too: calls resolve after the walk,
  // and writes to outer bindings cross the function boundary. Keep this scope
  // separate from the body, whose declarations are not visible in defaults.
  // Declarations, expressions, arrows and methods (including get/set/async/
  // generator forms) share the same closing-list/body shape.
  for (const [opening, closing] of groupEnds) {
    if (significant[opening].text !== '(') continue;
    const arrow = significant[closing + 1]?.text === '=>';
    const body = closing + (arrow ? 2 : 1);
    if (!arrow && !(significant[body]?.text === '{' && significant[body].functionBody)) continue;
    events.push({ start: significant[opening].start, scope: 'open', kind: 'function' });
    events.push({ start: significant[closing].end, scope: 'close' });
  }
  // Class field regions are deferred. A direct static block overrides only
  // its own class boundary; nested methods/classes retain their boundaries.
  for (let i = 0; i < significant.length; i++) {
    if (significant[i].text !== 'class' || significant[i].kind !== 'word' || significant[i].identifierName ||
        ['.', '?.'].includes(significant[i - 1]?.text) ||
        ['(', ':', '='].includes(significant[i + 1]?.text)) continue;
    let opening = i + 1;
    for (; opening < significant.length; opening++) {
      if (significant[opening].text === '{') break;
      if (groupEnds.has(opening)) opening = groupEnds.get(opening);
    }
    const closing = groupEnds.get(opening);
    if (closing === undefined) continue;
    const classEvent = events.find((event) => event.start === significant[opening].start);
    classEvent.kind = 'class';
    for (let j = opening + 1; j < closing; j++) {
      if (significant[j].text === 'static' && significant[j + 1]?.text === '{') {
        events.find((event) => event.start === significant[j + 1].start).kind = 'static';
      }
      if (groupEnds.has(j)) j = groupEnds.get(j);
    }
  }
  const startsTerm = (token) => (['word', 'number', 'string', 'template', 'regex'].includes(token.kind) &&
    !['in', 'instanceof'].includes(token.text)) || ['{', '!', '~', '++', '--'].includes(token.text);
  const newLine = (left, right) => lineTerminator.test(code.slice(left.end, right.start));
  const headBody = (i) => {
    const opening = significant[i + 1]?.text === 'await' ? i + 2 : i + 1;
    return significant[opening]?.text === '(' && groupEnds.has(opening) ? groupEnds.get(opening) + 1 : undefined;
  };
  // Return the first token AFTER a statement. Structured bodies can end at a
  // block close with no semicolon, including nested if/else and loop bodies.
  const statementEnds = new Map();
  const doTails = new Set();
  const statementEnd = (start) => {
    if (statementEnds.has(start)) return statementEnds.get(start);
    const first = significant[start];
    if (!first) return significant.length;
    let end;
    if (first.text === '{') end = (groupEnds.get(start) ?? start) + 1;
    else if (!first.identifierName && ['if', 'for', 'while', 'with', 'switch'].includes(first.text) && headBody(start) !== undefined) {
      end = statementEnd(headBody(start));
      if (first.text === 'if' && significant[end]?.text === 'else') end = statementEnd(end + 1);
    } else if (first.text === 'do') {
      end = statementEnd(start + 1);
      if (significant[end]?.text === 'while' && headBody(end) !== undefined) {
        doTails.add(end);
        end = headBody(end);
      }
      if (significant[end]?.text === ';') end++;
    } else if (first.text === 'try') {
      end = statementEnd(start + 1);
      if (significant[end]?.text === 'catch') end = statementEnd(headBody(end) ?? end + 1);
      if (significant[end]?.text === 'finally') end = statementEnd(end + 1);
    } else {
      end = significant.length;
      for (let j = start; j < significant.length; j++) {
        const token = significant[j];
        if (token.depth < first.depth || (token.depth === first.depth && token.text === '}')) { end = j; break; }
        if (token.depth !== first.depth) continue;
        const previous = significant[j - 1];
        if (j > start && newLine(previous, token) &&
            ((previous.canEnd && startsTerm(token)) ||
             (previous.text === '}' && previous.braceKind === 'block'))) { end = j; break; }
        if (token.text === ';') { end = j + 1; break; }
        if (groupEnds.has(j)) j = groupEnds.get(j);
      }
    }
    statementEnds.set(start, end);
    return end;
  };
  const boundary = (index) => significant[index]?.start ?? code.length;
  const conditionalRange = (start, end) => {
    if (start >= end) return;
    events.push({ start: boundary(start), conditional: 1 });
    events.push({ start: boundary(end), conditional: -1 });
  };
  const repeatedRange = (start, end) => {
    if (start >= end) return;
    events.push({ start: boundary(start), repeated: 1 });
    events.push({ start: boundary(end), repeated: -1 });
  };
  // Bound conditional expression operands. Groups are atomic; nested ternary
  // middle branches own their commas. ASI must not taint the next statement.
  const expressionTail = (start) => {
    const first = significant[start];
    if (!first) return start;
    let questions = 0;
    for (let j = start; j < significant.length; j++) {
      const token = significant[j];
      if (token.depth < first.depth) return j;
      if (token.depth !== first.depth) continue;
      if ([';', ')', ']', '}'].includes(token.text) ||
          (token.text === ',' && !questions) || (token.text === ':' && !questions)) return j;
      if (j > start && !questions && significant[j - 1].canEnd &&
          startsTerm(token) && newLine(significant[j - 1], token)) return j;
      if (token.text === '?') questions++;
      else if (token.text === ':' && questions) questions--;
      if (groupEnds.has(j)) j = groupEnds.get(j);
    }
    return significant.length;
  };
  for (let i = 0; i < significant.length; i++) {
    const token = significant[i];
    if (atomicKinds.has(token.kind) || token.identifierName || ['.', '?.'].includes(significant[i - 1]?.text) ||
        significant[i + 1]?.text === ':') continue;
    const bodyIndex = headBody(i);
    if (doTails.has(i) || (['else', 'do', 'try', 'finally'].includes(token.text) &&
        significant[bodyIndex]?.functionBody)) continue;
    if (['if', 'for', 'while', 'catch', 'switch'].includes(token.text) && bodyIndex !== undefined) {
      const end = statementEnd(bodyIndex);
      conditionalRange(bodyIndex, end);
      if (['for', 'while'].includes(token.text)) repeatedRange(bodyIndex, end);
      if (token.text === 'while') repeatedRange(i + 2, bodyIndex - 1);
      if (token.text === 'for') {
        const head = significant[bodyIndex - 1];
        // Find the matching head opener, before any head declarations.
        const opening = significant[i + 1]?.text === 'await' ? i + 2 : i + 1;
        events.push({ start: significant[opening].start, scope: 'open', kind: 'loop' });
        events.push({ start: significant[end - 1]?.end ?? head.end, scope: 'close' });
        // Only classic heads have two top-level semicolons. INIT retains
        // normal write semantics; CONDITION and UPDATE may not execute.
        const separators = [];
        for (let j = opening + 1; j < bodyIndex - 1; j++) {
          if (significant[j].text === ';') separators.push(j);
          if (groupEnds.has(j)) j = groupEnds.get(j);
        }
        if (separators.length === 2) {
          conditionalRange(separators[0] + 1, bodyIndex - 1);
          repeatedRange(separators[0] + 1, bodyIndex - 1);
        }
      }
    } else if (['else', 'do'].includes(token.text) ||
        (['try', 'finally', 'catch'].includes(token.text) && significant[i + 1]?.text === '{')) {
      const end = statementEnd(i + 1);
      conditionalRange(i + 1, end);
      if (token.text === 'do') repeatedRange(i + 1, end);
      if (token.text === 'do' && significant[end]?.text === 'while') {
        doTails.add(end);
        const tailEnd = headBody(end);
        if (tailEnd !== undefined) repeatedRange(end + 2, tailEnd - 1);
      }
    }
    // Concise arrow bodies have the same function boundary as braced bodies.
    if (token.text === '=>' && significant[i + 1]?.text !== '{') {
      events.push({ start: boundary(i + 1), scope: 'open', kind: 'function' });
      events.push({ start: boundary(expressionTail(i + 1)), scope: 'close' });
    }
    if (['&&', '||', '??', '&&=', '||=', '??='].includes(token.text)) {
      conditionalRange(i + 1, expressionTail(i + 1));
    } else if (token.text === '?') {
      let questions = 0;
      for (let j = i + 1; j < significant.length; j++) {
        const next = significant[j];
        if (next.depth < token.depth) break;
        if (next.depth !== token.depth) continue;
        if (next.text === '?') questions++;
        else if (next.text === ':') {
          if (questions) questions--;
          else {
            conditionalRange(i + 1, j);
            conditionalRange(j + 1, expressionTail(j + 1));
            break;
          }
        }
        if (groupEnds.has(j)) j = groupEnds.get(j);
      }
    }
  }
  const declarationAt = (tokenIndex) => {
    const token = tokens[tokenIndex];
    let previousIndex = tokenIndex - 1;
    while (previousIndex >= 0 && ['trivia', 'comment'].includes(tokens[previousIndex].kind)) previousIndex--;
    // A declaration starts at its keyword or a comma-separated declarator.
    // Reuse the RHS boundary/ASI scanner so a declaration on a previous line
    // cannot turn a subsequent plain assignment into a new shadowing binding.
    let declaration = ['const', 'let', 'var'].includes(tokens[previousIndex]?.text)
      ? tokens[previousIndex].text : undefined;
    if (tokens[previousIndex]?.text === ',') {
      for (let i = previousIndex - 1; i >= 0; i--) {
        const previous = tokens[i];
        if (previous.depth === token?.depth && [')', ']', '}'].includes(previous.text)) {
          // Skip a complete initializer group, including an object literal.
          while (i > 0) {
            i--;
            if (tokens[i].depth === token.depth && ['(', '[', '{'].includes(tokens[i].text)) break;
          }
          continue;
        }
        if (previous.depth < token?.depth ||
            (previous.depth === token?.depth && [';', '{'].includes(previous.text))) break;
        if (previous.depth === token?.depth && ['const', 'let', 'var'].includes(previous.text)) {
          let end = referenceEnd(previous.end);
          while (code[end] === ',' && end < token.start) end = referenceEnd(end + 1);
          declaration = token.start < end ? previous.text : undefined;
          break;
        }
      }
    }
    return declaration;
  };
  // Empty declarations must shadow outer aliases before a subsequent write.
  // Use the same declarator classification for initialized and empty names.
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const declaration = token.kind === 'word' ? declarationAt(i) : undefined;
    if (!declaration) continue;
    let next = i + 1;
    while (next < tokens.length && ['trivia', 'comment'].includes(tokens[next].kind)) next++;
    if (assignmentOperators.has(tokens[next]?.text)) continue;
    events.push({ start: token.start, name: token.text, declaration, empty: true });
  }
  let tokenIndex = 0;
  const bindingPattern = new RegExp('(?<!' + identifierContinueSource + ')(' + identifierSource + ')\\s*(\\|\\|=|&&=|\\?\\?=|=(?!=|>))', 'gu');
  for (const binding of code.matchAll(bindingPattern)) {
    while (tokenIndex < tokens.length && tokens[tokenIndex].end <= binding.index) tokenIndex++;
    const token = tokens[tokenIndex];
    // AG1: reject matches STARTING inside an atomic span, while retaining
    // declarations whose RHS contains a quoted member, e.g. globalThis["fetch"].
    if (token && token.start <= binding.index && atomicKinds.has(token.kind)) continue;
    let previousIndex = tokenIndex - 1;
    while (previousIndex >= 0 && ['trivia', 'comment'].includes(tokens[previousIndex].kind)) previousIndex--;
    if (['.', '?.'].includes(tokens[previousIndex]?.text)) continue;
    events.push({ start: binding.index, name: binding[1], operator: binding[2],
      right: binding.index + binding[0].length, declaration: declarationAt(tokenIndex) });
  }
  // Close an ending scope before opening its successor at the same offset.
  // In adjacent `){`, the parameter scope must end before the body opens,
  // so body declarations never register in the default-initializer scope.
  events.sort((a, b) => a.start - b.start ||
    Number(b.scope === 'close') - Number(a.scope === 'close'));
  // Register declarations before replay so a nested rebind, even one declared
  // later in its block/function, never records a write against an outer name.
  for (const event of events) {
    if (event.scope === 'open') {
      event.state = { bindings: new Map(), kind: event.kind };
      mayWrites.set(event.state.bindings, new Map());
      scopes.push(event.state);
    } else if (event.scope === 'close') {
      if (scopes.length > 1) scopes.pop();
    } else if (event.declaration) {
      const scope = declarationScope(event.declaration);
      if (!scope.has(event.name)) scope.set(event.name, { paths: [] });
    }
  }
  scopes.splice(1);
  let eventIndex = 0;
  let rootTokenIndex = 0;
  let conditionalDepth = 0;
  let repeatedDepth = 0;
  const deferredCalls = [];
  for (let root; (root = roots.exec(code));) {
    while (eventIndex < events.length && events[eventIndex].start <= root.index) {
      const event = events[eventIndex++];
      if (event.conditional) { conditionalDepth += event.conditional; continue; }
      if (event.repeated) { repeatedDepth += event.repeated; continue; }
      if (event.scope === 'open') { scopes.push(event.state); continue; }
      if (event.scope === 'close') { if (scopes.length > 1) scopes.pop(); continue; }
      if (event.empty) {
        const scope = declarationScope(event.declaration);
        // A repeated var declaration without an initializer retains its value.
        if (!scope.has(event.name)) scope.set(event.name, { paths: [] });
        continue;
      }
      const { name, operator, right, declaration } = event;
      let value = expression(right, undefined, false, referenceEnd(right));
      let next = value ? trivia(value.end) : right;
      if (code.startsWith('?.', next)) next = trivia(next + 2);
      if (code[next] === '(') value = null;
      if (operator !== '=') value = union([alias(name), value], value?.end ?? right);
      const scope = declaration ? declarationScope(declaration) : bindingScope(name) || scopes.at(-1).bindings;
      const writes = mayWrites.get(scope);
      writes.set(name, union([writes.get(name), value], value?.end ?? right));
      if (conditionalDepth > 0 || (!declaration && crossesDeferredScope(scope))) {
        value = union([scope.get(name), value], value?.end ?? right);
      }
      // Keep non-network bindings as shadowing entries, rather than exposing
      // the outer network alias when an inner binding has a different value.
      scope.set(name, known(value) ? value : undefined);
    }
    while (rootTokenIndex < tokens.length && tokens[rootTokenIndex].end <= root.index) rootTokenIndex++;
    const rootToken = tokens[rootTokenIndex];
    // Comments and template text are not executable. Retain the historical
    // scan inside ordinary quotes: configuration leaves also contain node -e shell code.
    if (rootToken && rootToken.start <= root.index && ['template', 'comment'].includes(rootToken.kind)) continue;
    if (repeatedDepth > 0 || crossesDeferredScope(scopes[0].bindings)) {
      deferredCalls.push({ start: root.index, scopes: scopes.map((scope) => {
        const bindings = new Map(scope.bindings);
        mayWrites.set(bindings, mayWrites.get(scope.bindings));
        return { ...scope, bindings };
      }) });
    } else inspectCall(root.index);
  }
  resolvingDeferred = true;
  for (const call of deferredCalls) {
    scopes.splice(0, scopes.length, ...call.scopes);
    inspectCall(call.start);
  }
  return calls;

  function inspectCall(start) {
    const value = expression(start);
    if (!value) return;
    // Keep scanning every root inside groups too: discarded comma segments
    // and bracket expressions can themselves contain network calls.
    if (!value.paths) return;
    let opening = trivia(value.end);
    if (code.startsWith('?.', opening)) opening = trivia(opening + 2);
    if (code[opening] !== '(') return;
    // Classify each candidate path independently, so alternatives involving
    // call/apply/bind or host methods retain their own argument positions.
    if (value.dynamicMember) calls.push({ opening: opening + 1, dynamicMember: true });
    for (const names of value.paths) {
      const reflect = names.length === 2 && names[0] === 'Reflect' && names[1] === 'apply';
      if (!knownPath(names) && !reflect) continue;
      let dynamicMember = value.dynamicMember;
      if (reflect) {
        const group = argumentsAt(opening + 1, true);
        if (!group) continue;
        const { start, end } = group.bounds[0];
        const first = expression(opening + 1 + start, undefined, true, opening + 1 + end);
        if ((!known(first) && !first?.dynamicMember) ||
            trivia(first.end) !== trivia(opening + 1 + end)) continue;
        dynamicMember ||= first.dynamicMember;
      }
      calls.push({ opening: opening + 1, indirect: indirectNames.has(names.at(-1)),
        reflect, dynamicMember });
    }
  }
}

function hasDynamicDestination(code, calls, sourceType) {
  for (const call of calls) {
    if (call.dynamicMember) return true;
    const context = scanJS(code, call.opening, code.length, sourceType ? { sourceType } : undefined).next().value?.context;
    const tail = stripJSComments(code.slice(call.opening), context);
    const args = callArguments(tail, false, ')', context);
    let destination = args?.[call.indirect ? 1 : 0];
    if (call.reflect) {
      const array = args?.[2];
      const elements = array?.startsWith('[') ? callArguments(array.slice(1), true, ']', context) : null;
      destination = elements && elements.closing + 2 === array.length ? elements.args[0] : undefined;
    }
    if (destination === undefined || !literalDestination(destination)) return true;
  }
  return false;
}

const metadata = new Set([
  'name', 'version', 'description', 'author', 'homepage', 'repository',
  'license', 'keywords', '$schema',
]);

const packageSourceTypes = new Map();
function sourceTypeForFile(file) {
  const extension = path.extname(file).toLowerCase();
  if (extension === '.mjs') return 'module';
  if (extension === '.cjs') return 'script';
  if (extension !== '.js') return undefined;
  const directories = [];
  let directory = path.dirname(path.resolve(file));
  let sourceType;
  for (;;) {
    if (packageSourceTypes.has(directory)) {
      sourceType = packageSourceTypes.get(directory);
      break;
    }
    directories.push(directory);
    const packageFile = path.join(directory, 'package.json');
    if (fs.existsSync(packageFile)) {
      const { type } = readJSON(packageFile);
      sourceType = type === 'module' ? 'module' : type === 'commonjs' ? 'script' : undefined;
      break; // The nearest package defines the scope even without a type.
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  for (const directory of directories) packageSourceTypes.set(directory, sourceType);
  return sourceType;
}

function scanSurfaces(text, file, plugin, sourceType) {
  if (plugin) {
    // Metadata declares hosts, but must not mask executable configuration.
    // Inspect each decoded leaf independently, including dynamic network calls.
    return stringLeaves(Object.fromEntries(Object.entries(plugin)
      .filter(([key]) => !metadata.has(key)))).map(value => analysisVariants(value));
  }
  if (/\.json$/iu.test(file)) {
    try {
      // Scan decoded object keys and string values, not serialized quote
      // escapes. Retain each unit's raw text before JS transformations.
      return stringLeaves(JSON.parse(text)).map(value => analysisVariants(value));
    }
    catch { /* Keep the raw scan when JSON cannot be decoded. */ }
  }
  return [analysisVariants(text, sourceType)];
}

function inspectHooks(value, dir, origin) {
  // File references are expanded by the cycle-guarded component queue below.
  if (Array.isArray(value)) {
    for (const item of value) inspectHooks(item, dir, origin);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const events = value.hooks && !Array.isArray(value.hooks) ? value.hooks : value;
  for (const [event, groups] of Object.entries(events)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      for (const hook of group.hooks || []) {
        const command = hook.command || hook.url || hook.prompt || '(inline hook)';
        verdict.hooks.push(event + ':' + origin + ' — ' + command);
        // Presence of a matcher is not proof of a project-relevance gate.
        // Treat these automatic events as broad until reviewed manually.
        if (['UserPromptSubmit', 'PreToolUse', 'PostToolUse'].includes(event)) verdict.has_broad_scope_hooks = true;
      }
    }
  }
}

try {
  const marketplace = readJSON(path.join(root, '.claude-plugin/marketplace.json'));
  if (!Array.isArray(marketplace.plugins) || !marketplace.plugins.length) throw new Error('No marketplace plugins');
  for (const entry of marketplace.plugins) {
    let origin = '.claude-plugin/marketplace.json';
    try {
      const dir = pluginDir(entry);
      origin = relative(path.join(dir, '.claude-plugin/plugin.json'));
      const plugin = readJSON(path.join(root, origin));
      const readmeFile = path.join(dir, 'README.md');
      const readme = fs.readFileSync(readmeFile, 'utf8');
      const disclosure = readme.toLowerCase();
      const declaredHosts = new Set();
      for (const value of [plugin.homepage, plugin.repository]) {
        if (typeof value === 'string') {
          try { declaredHosts.add(new URL(value).hostname.toLowerCase()); } catch { /* Not a URL. */ }
        }
      }
      if (typeof plugin.description !== 'string' || plugin.description !== entry.description) {
        violate(origin, 'Description differs from marketplace entry');
      }
      const entryComponents = componentDeclarations(entry);
      const components = declaredPaths(componentDeclarations(plugin, entry), dir);
      const declaredFiles = new Set();
      const executableFiles = new Set();
      const contentFields = new Set(['commands', 'agents', 'skills', 'outputStyles', 'themes']);
      const visitedConfigs = new Set();
      const requiredConfigs = new Set();
      const collectHookConfigs = (value) => {
        if (typeof value === 'string') requiredConfigs.add(localPath(dir, value));
        else if (Array.isArray(value)) value.forEach(collectHookConfigs);
      };
      collectHookConfigs(plugin.hooks);
      collectHookConfigs(entry.hooks);
      for (const [field, ref] of [
        ['hooks', './hooks/hooks.json'], ['mcpServers', './.mcp.json'],
        ['lspServers', './.lsp.json'], ['monitors', './monitors/monitors.json'],
      ]) {
        const config = localPath(dir, ref);
        if (!fs.existsSync(config)) continue;
        requiredConfigs.add(config);
        components.push({ field, ref });
      }
      if (plugin.hooks) inspectHooks(plugin.hooks, dir, origin);
      const entryOrigin = '.claude-plugin/marketplace.json';
      if (entry.hooks) inspectHooks(entry.hooks, dir, entryOrigin);
      const pending = components.map((component) => ({ ...component, origin }));
      for (let i = 0; i < pending.length; i++) {
        const { field, ref, origin: refOrigin } = pending[i];
        try {
          const target = localPath(dir, ref);
          if (!fs.existsSync(target)) {
            violate(refOrigin, 'Declared ' + field + ' component missing: ' + ref);
            continue;
          }
          for (const file of fs.statSync(target).isDirectory() ? walk(target) : [target]) {
            declaredFiles.add(file);
            if (contentFields.has(field)) continue;
            executableFiles.add(file);
            // Every executable reference can itself be a JSON config, even
            // without a JSON extension. Keep hook inspection cycle-guarded too.
            const key = field + ':' + fs.realpathSync(file);
            if (visitedConfigs.has(key)) continue;
            visitedConfigs.add(key);
            let config;
            try { config = readJSON(file); }
            catch (error) {
              if (requiredConfigs.has(file)) violate(relative(file), error.message);
              continue; // Script payloads still receive their raw scan.
            }
            if (field === 'hooks') inspectHooks(config, dir, relative(file));
            for (const next of commandReferences(config, dir)) {
              pending.push({ field, ref: next, origin: relative(file) });
            }
          }
        } catch (error) { violate(refOrigin, error.message); }
      }
      for (const file of [...walk(dir), path.join(root, entryOrigin)]) {
        const isEntry = relative(file) === entryOrigin;
        // Scan code/config anywhere, plus declared payloads of any extension.
        // Executable references override the prose exclusion; prompt docs do not.
        if (/\.md$/iu.test(file) && !executableFiles.has(file)) continue;
        const hookPayload = relative(file).startsWith(relative(path.join(dir, 'hooks')) + '/');
        if (!hookPayload && !declaredFiles.has(file) && !executableFiles.has(file) && !/\.(?:mjs|js|cjs|json|sh|bash|py|rb|ps1)$/iu.test(file)) continue;
        const bytes = fs.readFileSync(file);
        const ref = relative(file);
        const hosts = new Set();
        let networkDetected = false;
        let dynamic = false;
        const sourceType = sourceTypeForFile(file);
        for (const variants of scanSurfaces(bytes.toString('utf8'), file,
          isEntry ? entryComponents : ref === origin ? plugin : null, sourceType)) {
          for (const code of variants) {
            if (downloads.test(code)) verdict.may_download_additional_software = true;
            if (telemetry.test(code)) {
              verdict.has_undisclosed_telemetry = true;
              violate(ref, 'Telemetry import or URL detected; explicit review required');
            }
            const calls = networkCalls(code, sourceType);
            if (network.test(code) || calls.length) networkDetected = true;
            if (hasDynamicDestination(code, calls, sourceType)) dynamic = true;
            for (const [url] of code.matchAll(/https?:\/\/[^\s"'`<>\\)]+/giu)) {
              try { hosts.add(new URL(url).hostname.toLowerCase()); }
              catch { violate(ref, 'Network URL could not be statically resolved'); }
            }
          }
        }
        if (networkDetected || dynamic) {
          verdict.may_make_external_network_calls = true;
          for (const host of hosts) {
            const local = ['localhost', '127.0.0.1', '[::1]'].includes(host);
            const escapedHost = host.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
            const disclosed = new RegExp('(?<![a-z0-9-])' + escapedHost + '(?![a-z0-9-])', 'u').test(disclosure) || declaredHosts.has(host) ||
              (local && /\bCDP\b|remote debugging|Chrome DevTools/iu.test(readme));
            if (!disclosed) violate(ref, 'Undisclosed network host: ' + host);
          }
          if ((!hosts.size || dynamic) && !/\bnetwork\b/iu.test(readme)) {
            violate(ref, 'Network API indicator without a disclosed host or network disclosure');
          }
        }
      }
    } catch (error) { violate(origin, error.message); }
  }
} catch (error) { violate('.claude-plugin/marketplace.json', error.message); }

verdict.passes = verdict.violations.length === 0;
const json = JSON.stringify(verdict, null, 2) + '\n';
let output;
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--out' || !args[1])) {
  console.error('Usage: node tools/ci/description-behavior.mjs [--out FILE]');
  process.exitCode = 1;
} else {
  output = args[1];
  if (output) {
    try { fs.writeFileSync(path.resolve(output), json); }
    catch {
      console.error('FAIL DESCRIPTION_BEHAVIOR unable to write verdict');
      process.exitCode = 1;
    }
  }
  process.stdout.write(json);
  if (!verdict.passes) process.exitCode = 1;
}
