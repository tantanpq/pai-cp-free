'use strict';

const normalizeCaps = value => new Set((Array.isArray(value) ? value : []).map(item => String(item).toUpperCase()));

class HostRouter {
  constructor({ sessionOwnerLookup = null } = {}) {
    this.hosts = new Map();
    this.sessionOwnerLookup = sessionOwnerLookup;
  }

  update(cards) {
    if (!Array.isArray(cards)) throw new Error('HOST_CARDS_INVALID');
    this.hosts.clear();
    for (const card of cards) {
      if (!card?.hostId) throw new Error('HOST_ID_REQUIRED');
      this.hosts.set(card.hostId, { ...card, capabilities: [...normalizeCaps(card.capabilities)] });
    }
  }

  select({ requiredCapabilities = [], sessionId = null, localityHint = null } = {}) {
    if (sessionId && typeof this.sessionOwnerLookup === 'function') {
      const owner = this.sessionOwnerLookup(sessionId);
      if (owner) {
        const card = this.hosts.get(owner);
        if (!card) return { status: 'OWNER_HOST_NOT_IN_CURRENT_CARDS', hostId: owner, movable: false };
        return { status: 'SESSION_PINNED', hostId: owner, card: { ...card }, movable: false };
      }
    }
    const required = normalizeCaps(requiredCapabilities);
    const candidates = [...this.hosts.values()].filter(card => {
      const caps = normalizeCaps(card.capabilities);
      const online = card.transportOnline === true;
      const eligible = card.authorityEligible === true && card.hostControlEligible === true;
      return online && eligible && [...required].every(cap => caps.has(cap));
    }).map(card => {
      const headroom = Number.isFinite(card.headroom) ? card.headroom : 0;
      const load = Number.isFinite(card.load) ? card.load : 0;
      const locality = localityHint && card.locality === localityHint ? 10 : 0;
      return { card, score: locality + headroom * 3 - load };
    }).sort((a, b) => b.score - a.score || String(a.card.hostId).localeCompare(String(b.card.hostId)));
    if (!candidates.length) return { status: 'NO_ELIGIBLE_HOST', requiredCapabilities: [...required] };
    return { status: 'SELECTED', hostId: candidates[0].card.hostId, card: { ...candidates[0].card }, score: candidates[0].score, movable: false };
  }
}

module.exports = { HostRouter };
