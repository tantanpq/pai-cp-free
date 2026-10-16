'use strict';
// Frozen candidate-local equivalence of the live task-box.js contract consulted
// for Gateway R2. It intentionally never imports from ProgramData at runtime.
const TYPES = new Set(['DRAFT', 'DISPATCH', 'CONTINUATION', 'HANDOFF']);
const PRIORITIES = new Set(['P0', 'P1', 'P2', 'P3']);
const DATA_MODES = new Set(['NONE', 'READ_ONLY', 'READ_WRITE', 'PORTABLE_ARTIFACT']);
const RESULT_STATUS = new Set(['DONE', 'NOT_DONE', 'BLOCKED']);
const ID_RE = /^[A-Z][A-Z0-9_]{2,63}$/;
const SAFE_PATH_RE = /^(?!\/)(?![A-Za-z]:)(?!.*(?:^|\/)\.?(?:\/|$))[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const FIELDS = new Set(['TASK_ID','TYPE','ROOT_ID','PARENT_ID','PRIORITY','MUTABLE_SCOPE','REQUIRED_CAPABILITIES','WORKDIR','DATA_MODE']);
const RESULT_FIELDS = ['STATUS','TESTS','OUTPUTS','NEXT','BLOCKER'];
const fail = message => { throw new Error(message); };
const scalar = (value, name) => { if (typeof value !== 'string' || !value.trim() || /[\r\n]/.test(value)) fail(`${name} must be a non-empty single line`); return value.trim(); };
const safe = (value, name) => { if (!SAFE_PATH_RE.test(value)) fail(`${name} must be a safe relative path`); };
const ident = (value, name) => { if (!ID_RE.test(value || '')) fail(`${name} is invalid`); };
const line = value => { const match = /^([A-Z_]+):[ ]*(.*)$/.exec(value); if (!match) fail(`malformed header line: ${value}`); return match.slice(1); };
function validate(artifact) {
  if (!artifact || typeof artifact !== 'object') fail('artifact must be an object'); const header = artifact.header || artifact;
  for (const field of ['TASK_ID','TYPE','PRIORITY','MUTABLE_SCOPE','REQUIRED_CAPABILITIES']) scalar(header[field], field);
  ident(header.TASK_ID, 'TASK_ID'); if (!TYPES.has(header.TYPE)) fail('TYPE is invalid'); if (!PRIORITIES.has(header.PRIORITY)) fail('PRIORITY is invalid');
  for (const field of ['ROOT_ID','PARENT_ID']) if (header[field] !== undefined) ident(header[field], field);
  if (header.MUTABLE_SCOPE !== 'NONE') header.MUTABLE_SCOPE.split(',').forEach(value => safe(value.trim(), 'MUTABLE_SCOPE'));
  if (header.WORKDIR !== undefined) { const workdir = scalar(header.WORKDIR, 'WORKDIR'); if (workdir !== '.') safe(workdir, 'WORKDIR'); }
  if (header.DATA_MODE !== undefined && !DATA_MODES.has(header.DATA_MODE)) fail('DATA_MODE is invalid');
  if ((header.WORKDIR === undefined) !== (header.DATA_MODE === undefined)) fail('WORKDIR and DATA_MODE must be supplied together');
  if (header.TYPE === 'HANDOFF') { if (artifact.task !== undefined) fail('HANDOFF must not contain TASK'); if (!artifact.result) fail('HANDOFF requires Result'); for (const field of RESULT_FIELDS) scalar(artifact.result[field], `Result.${field}`); if (!RESULT_STATUS.has(artifact.result.STATUS)) fail('Result.STATUS is invalid'); }
  else { if (typeof artifact.task !== 'string' || !artifact.task.trim()) fail(`${header.TYPE} requires a non-empty TASK body`); if (artifact.result !== undefined) fail(`${header.TYPE} must not contain Result`); }
  return { header, task: artifact.task, result: artifact.result };
}
function parseArtifact(markdown) {
  if (typeof markdown !== 'string') fail('markdown must be a string'); if (markdown.startsWith('\uFEFF')) markdown = markdown.slice(1); const lines = markdown.replace(/\r\n/g, '\n').split('\n'); if (lines[0] !== '# TASK BOX') fail('first line must be # TASK BOX');
  const header = {}; let index = 1; for (; index < lines.length && lines[index] !== '---'; index += 1) { const [field, value] = line(lines[index]); if (!FIELDS.has(field)) fail(`unknown header field: ${field}`); if (Object.hasOwn(header, field)) fail(`duplicate header field: ${field}`); header[field] = value; }
  if (lines[index] !== '---') fail('header must end with ---'); const rest = lines.slice(index + 1); while (rest.length && rest.at(-1) === '') rest.pop();
  if (header.TYPE === 'HANDOFF') { if (rest[0] !== 'Result:' || rest.length !== 6) fail('HANDOFF body must contain exact Result'); const result = {}; RESULT_FIELDS.forEach((field, offset) => { const [got, value] = line(rest[offset + 1]); if (got !== field) fail(`expected Result.${field}`); result[field] = value; }); return validate({ header, result }); }
  if (rest[0] !== 'TASK:') fail(`${header.TYPE || 'artifact'} body must start with TASK:`); return validate({ header, task: rest.slice(1).join('\n').replace(/\n+$/, '') });
}
module.exports = { parseArtifact };
