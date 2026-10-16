'use strict';

class TakeoverController {
  constructor({ transcript = null } = {}) {
    this.state = 'AGENT_CONTROL';
    this.transcript = transcript;
    this.humanActor = null;
  }

  request({ actor = 'TAN' } = {}) {
    if (this.state !== 'AGENT_CONTROL') throw new Error('TAKEOVER_STATE_INVALID');
    this.state = 'TAKEOVER_REQUESTED';
    this.humanActor = actor;
    this.transcript?.append({ actor: 'SYSTEM', type: 'takeover_requested', meta: { actor } });
    return this.snapshot();
  }

  grant() {
    if (this.state !== 'TAKEOVER_REQUESTED') throw new Error('TAKEOVER_NOT_REQUESTED');
    this.state = 'HUMAN_CONTROL';
    this.transcript?.append({ actor: 'SYSTEM', type: 'human_control_granted', meta: { actor: this.humanActor } });
    return this.snapshot();
  }

  release() {
    if (this.state !== 'HUMAN_CONTROL') throw new Error('HUMAN_CONTROL_NOT_ACTIVE');
    this.state = 'RELEASED';
    this.transcript?.append({ actor: 'SYSTEM', type: 'human_control_released', meta: { actor: this.humanActor } });
    return this.snapshot();
  }

  resumeAgent() {
    if (this.state !== 'RELEASED') throw new Error('TAKEOVER_RELEASE_REQUIRED');
    this.state = 'AGENT_CONTROL';
    this.humanActor = null;
    this.transcript?.append({ actor: 'SYSTEM', type: 'agent_control_resumed' });
    return this.snapshot();
  }

  canWrite(actor) {
    const normalized = String(actor || '').toUpperCase();
    if (this.state === 'AGENT_CONTROL') return ['AGENT', 'CHATGPT', 'GROK', 'ANTI'].includes(normalized);
    if (this.state === 'HUMAN_CONTROL') return ['HUMAN', 'TAN'].includes(normalized);
    return false;
  }

  snapshot() { return { state: this.state, humanActor: this.humanActor }; }
}

module.exports = { TakeoverController };
