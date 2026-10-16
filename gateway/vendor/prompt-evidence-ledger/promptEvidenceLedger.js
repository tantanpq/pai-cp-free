'use strict';

// Candidate-only deterministic adapter. Storage is injected by the existing governed owner.
const crypto = require('crypto');
const SCHEMA_VERSION = 'pai.user-prompt-evidence.v1';
const sha256 = value => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));

class InMemoryAppendOnlyStore {
  constructor() { this.events = []; this.keys = new Map(); this.outcomes = []; }
  append(event) {
    const previous = this.keys.get(event.idempotency_key);
    if (previous) return { inserted: false, event: clone(previous) };
    const frozen = Object.freeze(clone(event));
    this.keys.set(event.idempotency_key, frozen); this.events.push(frozen);
    return { inserted: true, event: clone(frozen) };
  }
  all() { return this.events.map(clone); }
  addOutcome(link) { this.outcomes.push(Object.freeze(clone(link))); }
}

function classify(text) {
  const flags = [];
  if (/\b(sk-[A-Za-z0-9_-]{12,}|api[_ -]?key|password|secret|bearer\s+[A-Za-z0-9._-]+)/i.test(text)) flags.push('SECRET_SUSPECTED');
  if (/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b|\b\+?\d[\d ()-]{7,}\d\b/.test(text)) flags.push('PII_SUSPECTED');
  return { classification: flags.length ? 'RESTRICTED' : 'INTERNAL', flags };
}

function idempotency(sourceSurface, sourceMessageId, contentHash) {
  return sha256([sourceSurface, sourceMessageId || '', contentHash].join('\u001f'));
}

function capturePrompt(store, input) {
  if (!store || typeof store.append !== 'function') throw new TypeError('append-only store required');
  if (!input || typeof input.raw_user_prompt !== 'string') throw new TypeError('exact raw_user_prompt string required');
  if (!input.source_surface) throw new TypeError('source_surface required');
  const raw = input.raw_user_prompt;
  const content_sha256 = sha256(raw);
  const privacy = classify(raw);
  const key = idempotency(input.source_surface, input.source_message_id, content_sha256);
  const event = {
    event_id: `upe_${key.slice(0, 32)}`,
    schema_version: SCHEMA_VERSION,
    idempotency_key: key,
    source_surface: input.source_surface,
    source_message_id: input.source_message_id || null,
    conversation_ref: input.conversation_ref || null,
    session_ref: input.session_ref || null,
    project_ref: input.project_ref || null,
    observed_at_utc: input.observed_at_utc || new Date().toISOString(),
    raw_user_prompt: raw,
    content_sha256,
    provenance_ref: input.provenance_ref || null,
    privacy_classification: privacy.classification,
    privacy_flags: privacy.flags
  };
  return store.append(event);
}

// Fail-open wrapper: caller continues downstream; the caller-owned outbox may receive failure metadata.
function captureFailOpen(store, input, reportFailure) {
  try { return { captured: true, ...capturePrompt(store, input) }; }
  catch (error) {
    const failure = { kind: 'PROMPT_EVIDENCE_CAPTURE_FAILED', source_surface: input && input.source_surface || null, observed_at_utc: new Date().toISOString(), error: String(error.message) };
    if (typeof reportFailure === 'function') reportFailure(failure);
    return { captured: false, failure };
  }
}

function atomize(event) {
  const prompt = event.raw_user_prompt.toLowerCase();
  const kind = /don't|do not|never|avoid|forbidden|đừng|không được|tránh|không thích|ghét/.test(prompt) ? 'rejection'
    : /must|require|constraint|only|phải|bắt buộc|chỉ được/.test(prompt) ? 'constraint'
    : /prefer|like|want|thích|ưu tiên|muốn/.test(prompt) ? 'preference'
    : /decide|decision/.test(prompt) ? 'decision'
    : /think|hypothesis|maybe/.test(prompt) ? 'hypothesis' : 'goal';
  const key = prompt.replace(/[^a-z0-9 ]/g, ' ').trim().split(/\s+/).slice(0, 8).join(' ');
  return { assertion_id: `atom_${sha256(event.event_id + kind).slice(0, 20)}`, level: 'INTENT_ATOM', kind, key, confidence: 0.5, evidence_event_ids: [event.event_id], provenance_refs: [event.provenance_ref] };
}

// This is deliberately a small, auditable Vietnamese/English semantic vocabulary. It is
// a projection over evidence, never a replacement for the captured prompt.
function normalizeSemanticText(text) {
  // Map Vietnamese d-stroke before accent folding. NFD does not decompose \u0111/\u0110,
  // so this explicit code-point mapping keeps matching deterministic across editors.
  return text.replace(/[\u0111\u0110]/g, character => character === '\u0110' ? 'D' : 'd')
    .toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

const BEHAVIORAL_SYNONYMS = Object.freeze({
  concise: 'concise', brief: 'concise', short: 'concise', 'ngan gon': 'concise', 'suc tich': 'concise',
  checklist: 'checklist', checklists: 'checklist', 'danh sach kiem tra': 'checklist',
  structured: 'structured', structure: 'structured', 'co cau truc': 'structured',
  update: 'update', updates: 'update', status: 'update', 'cap nhat': 'update',
  response: 'response', responses: 'response', communication: 'communication', 'giao tiep': 'communication',
  plan: 'plan', plans: 'plan', approach: 'approach', process: 'process', workflow: 'workflow', 'quy trinh': 'process'
});

function genericBehaviorPattern(normalized, correction, dislike) {
  const behavioralLanguage = /\b(prefer|like|want|favor|must|require|only|always|never|avoid|do not|dont|dung|khong|phai|bat buoc|chi duoc|uu tien|toi thich|muon|sua|dinh chinh|correct|instead)\b/.test(normalized);
  const ideaOnly = /\b(idea|brainstorm|brain storm|maybe|hypothesis|think about|y tuong|dong nao|thu nghiem)\b/.test(normalized);
  const tokens = normalized.split(' ').filter(Boolean);
  const behavioralTerms = ['concise', 'brief', 'short', 'ngan', 'suc', 'checklist', 'structured', 'structure', 'update', 'status', 'response', 'communication', 'giao', 'plan', 'approach', 'process', 'workflow', 'quy', 'format', 'style'];
  if (!behavioralLanguage || ideaOnly || tokens.length < 4 || !tokens.some(token => behavioralTerms.includes(token))) return null;
  const phrase = normalized.replace(/\b(i|me|my|please|prefer|preference|like|want|favor|must|require|only|always|never|avoid|do|not|dont|dung|khong|phai|bat|buoc|chi|duoc|uu|tien|toi|thich|muon|sua|dinh|chinh|correct|instead|use|make|keep|hay)\b/g, ' ');
  const canonical = [];
  let remaining = ` ${phrase} `;
  for (const source of Object.keys(BEHAVIORAL_SYNONYMS).sort((a, b) => b.length - a.length)) {
    const matcher = new RegExp(`\\b${source.replace(/ /g, '\\s+')}\\b`, 'g');
    if (matcher.test(remaining)) {
      canonical.push(BEHAVIORAL_SYNONYMS[source]);
      remaining = remaining.replace(matcher, ' ');
    }
  }
  const signature = [...new Set(canonical)].sort().join('-');
  return signature ? `behavioral-generic-${signature}` : null;
}

function semanticSignal(event) {
  const normalized = normalizeSemanticText(event.raw_user_prompt);
  const correction = /\b(sua|dinh chinh|khong phai|thay vao do|correct|correction|instead)\b/.test(normalized);
  // A negative marker is evidence of dislike only when this turn resolves to a
  // bounded behavioral concept below. This prevents arbitrary negative prose
  // from becoming a behavioral memory card.
  const explicitNegative = /\b(khong thich|ghet|dung|tranh|khong|do not|dont|never|avoid)\b/.test(normalized);
  const global = /\b(luon luon|mai mai|always|never)\b/.test(normalized);
  const noise = normalized.length < 8 || /^(ok|okay|cam on|thanks|tiep tuc( hoan thien giup minh)?|lam tiep|continue|yes|vang)$/.test(normalized);
  const patterns = [
    ['reversible-plans', /\b(reversible|rollback|undo|hoan tac|dao nguoc)\b/],
    ['no-publication', /\b(publish|public|cong khai|xuat ban)\b/],
    ['concise-communication', /\b(concise|brief|ngan gon|suc tich)\b/],
    ['vietnamese-language', /\b(tieng viet|vietnamese)\b/],
    ['farm-distribution-home-reserve', /\bhome\b.*\bfarm\b|\bfarm\b.*\bhome\b|\bhome\b.*\b(om het|all)\b.*\b(task|viec)\b|\bhome\b.*\b(task|viec)\b.*\b(om het|all)\b/],
    ['direct-cli-fallback-when-control-path-blocked', /\b(codex )?cli\b.*\b(audit|direct|truc tiep|control path|rebuild)\b|\b(control path|rebuild)\b.*\bcli\b|\b(viec nho|small work)\b.*\brebuild\b|\brebuild\b.*\b(viec nho|small work)\b/],
    ['do-not-repeat-known-information', /\b(do not ask me again|already provided|already known)\b|\b(dung|khong)\b.*\b(hoi|ask)\b.*\b(lai|again|thong tin|information)\b|\bthong tin\b.*\b(co roi|da)\b.*\b(dung|khong)\b.*\b(hoi|ask)\b/]
  ];
  const matched = noise ? [] : patterns.filter(([, matcher]) => matcher.test(normalized)).map(([pattern]) => pattern);
  if (!matched.length) {
    const generic = genericBehaviorPattern(normalized, correction, explicitNegative);
    if (generic) matched.push(generic);
  }
  const dislike = explicitNegative && matched.length > 0;
  // Unknown substantive prompts remain captured evidence but are not retained as a
  // behavioral card until a governed vocabulary/qualifier is added.
  return { normalized, correction, dislike, global, noise, patterns: matched };
}

// Stable bridge/server projection. The private evidence event retains raw text; this
// return value intentionally does not expose it.
function projectBehavioralTurn(input) {
  if (!input || typeof input.message !== 'string') throw new TypeError('message string required');
  const store = new InMemoryAppendOnlyStore();
  const requestId = input.requestId == null ? null : String(input.requestId);
  const event = capturePrompt(store, {
    source_surface: 'pai-chief-bridge', source_message_id: requestId,
    conversation_ref: input.roomId == null ? null : String(input.roomId),
    session_ref: input.topicId == null ? null : String(input.topicId),
    project_ref: input.projectId == null ? null : String(input.projectId),
    observed_at_utc: input.now || new Date().toISOString(), raw_user_prompt: input.message,
    provenance_ref: requestId ? `bridge:${requestId}` : null
  }).event;
  const signal = semanticSignal(event);
  const memory = buildBehavioralMemory(store.all());
  return { model: memory.model, cards: memory.cards, correctionObserved: signal.correction, dislikeObserved: signal.dislike, noise: signal.noise };
}

function eventScope(event, signal) {
  if (signal.global) return { kind: 'GLOBAL_ALWAYS', ref: 'GLOBAL' };
  if (event.project_ref) return { kind: 'PROJECT', ref: event.project_ref };
  if (event.conversation_ref) return { kind: 'CONVERSATION', ref: event.conversation_ref };
  return { kind: 'SURFACE', ref: event.source_surface };
}

function buildBehavioralMemory(events, options = {}) {
  const retentionWindow = options.retention_window_events || 4;
  const globalLimit = options.global_always_limit || 3;
  const groups = new Map();
  events.forEach((event, index) => {
    const signal = semanticSignal(event);
    if (signal.noise || !signal.patterns.length) return;
    const scope = eventScope(event, signal);
    signal.patterns.forEach(pattern => {
      const key = `${pattern}:${scope.kind}:${scope.ref}`;
      const entry = groups.get(key) || { pattern, scope, evidence: [], corrections: [], dislikes: [], last_index: index };
      entry.evidence.push(event.event_id);
      if (signal.correction) entry.corrections.push(event.event_id);
      if (signal.dislike) entry.dislikes.push(event.event_id);
      entry.last_index = index;
      groups.set(key, entry);
    });
  });
  let globals = 0;
  const cards = [...groups.values()].sort((a, b) => `${a.pattern}:${a.scope.ref}`.localeCompare(`${b.pattern}:${b.scope.ref}`)).map(group => {
    const correction = group.corrections.length > 0 || group.dislikes.length > 0;
    const age = events.length - 1 - group.last_index;
    const reinforced = group.evidence.length >= 2;
    const eligibleGlobal = group.scope.kind !== 'GLOBAL_ALWAYS' || globals++ < globalLimit;
    const state = !eligibleGlobal ? 'CANDIDATE' : (correction || reinforced ? 'ACTIVE' : (age >= retentionWindow ? 'EXPIRED' : 'CANDIDATE'));
    return {
      card_id: `memory_${sha256(`${group.pattern}\u001f${group.scope.kind}\u001f${group.scope.ref}`).slice(0, 24)}`,
      pattern: group.pattern,
      scope: group.scope,
      strength: group.evidence.length + group.corrections.length + group.dislikes.length,
      retention: { state, expires_after_event_index: group.last_index + retentionWindow },
      promotion: correction ? 'APPLY_NOW' : (reinforced ? 'REINFORCED' : 'PENDING'),
      evidence_event_ids: group.evidence,
      correction_event_ids: group.corrections,
      dislike_event_ids: group.dislikes
    };
  });
  return { model: 'pai.behavioral-memory.v1', retention_window_events: retentionWindow, global_always_limit: globalLimit, cards };
}

function recallMemory(memory, context = {}) {
  const scopeRef = context.project_ref || context.conversation_ref || context.source_surface || null;
  return memory.cards.filter(card => card.retention.state === 'ACTIVE' &&
    (card.scope.kind === 'GLOBAL_ALWAYS' || card.scope.ref === scopeRef))
    .sort((a, b) => b.strength - a.strength || a.card_id.localeCompare(b.card_id));
}

function rebuild(events) {
  const atoms = events.map(atomize);
  const patterns = [];
  for (let i = 1; i < atoms.length; i++) {
    const a = atoms[i - 1], b = atoms[i];
    const relation = a.kind === b.kind ? 'REPEATS' : (b.kind === 'rejection' ? 'CONTRADICTS' : 'REFINES');
    patterns.push({ assertion_id: `pattern_${sha256(a.assertion_id + b.assertion_id).slice(0, 20)}`, level: 'PATTERN_HYPOTHESIS', relation, confidence: 0.4, evidence_event_ids: [a.evidence_event_ids[0], b.evidence_event_ids[0]] });
  }
  const grouped = new Map(); for (const a of atoms) grouped.set(`${a.kind}:${a.key}`, [...(grouped.get(`${a.kind}:${a.key}`) || []), a]);
  const profile_candidates = [...grouped.values()].filter(group => group.length >= 2).map(group => ({
    assertion_id: `profile_${sha256(group.map(x => x.assertion_id).join()).slice(0, 20)}`,
    level: 'PROFILE_CANDIDATE', qualification: 'UNQUALIFIED_REQUIRES_EXISTING_MIND_REVIEW', stable_truth: false,
    confidence: 0.6, evidence_event_ids: group.flatMap(x => x.evidence_event_ids)
  }));
  const checkpoint = { schema_version: 'pai.prompt-checkpoint.v1', source_event_ids: events.map(e => e.event_id), atom_count: atoms.length, pattern_count: patterns.length, profile_candidate_count: profile_candidates.length, rebuildable: true };
  const behavioral_memory = buildBehavioralMemory(events);
  return { atoms, patterns, profile_candidates, behavioral_memory, checkpoint };
}

function linkOutcome(store, link) {
  if (!link || !link.prompt_event_id || !link.result_status || !link.result_ref) throw new TypeError('minimal outcome link required');
  const forbidden = ['assistant_response', 'assistant_body', 'answer_text', 'chain_of_thought'];
  if (forbidden.some(k => Object.prototype.hasOwnProperty.call(link, k))) throw new Error('forbidden outcome field');
  store.addOutcome({ prompt_event_id: link.prompt_event_id, result_status: link.result_status, result_ref: link.result_ref, user_feedback_classification: link.user_feedback_classification || null });
}

module.exports = { SCHEMA_VERSION, InMemoryAppendOnlyStore, capturePrompt, captureFailOpen, rebuild, buildBehavioralMemory, recallMemory, linkOutcome, projectBehavioralTurn, sha256 };
