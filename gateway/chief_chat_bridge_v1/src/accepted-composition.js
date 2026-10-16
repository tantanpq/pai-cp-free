'use strict';

// Composition of accepted advisory owners. No lifecycle, scheduler or writer.
const { createLearningGate } = require('../../chief_learning_v1/src/chief-learning-gate');
const { createCognitiveLifecycle } = require('../../cognitive_lifecycle_v1/src/cognitive-lifecycle');
const { createKnowledgeRoom } = require('../../knowledge_room_v1/src/knowledge-room');
const domainIntelligence = require('../../pai_domain_v1/runtime/domain-intelligence');
const REQUIRED_BINDINGS = Object.freeze({
  learning: ['generate', 'evaluate', 'inspect', 'export'],
  cognitiveLifecycle: ['scoreAttention', 'metacognitiveRoute', 'consolidateEpisode'],
  domainIntelligence: ['economicPolicy'],
  knowledgeRoom: ['compile', 'routeSignals', 'status']
});
function validateComposition(bindings) {
  for (const [name, methods] of Object.entries(REQUIRED_BINDINGS)) {
    if (!bindings[name] || methods.some(method => typeof bindings[name][method] !== 'function')) {
      throw new Error('CHIEF_ACCEPTED_CAPABILITY_MISSING:' + name);
    }
  }
  return bindings;
}
function createAcceptedComposition({ continuity, now } = {}) {
  const learning = createLearningGate({ continuity, ...(now ? { now } : {}) });
  return Object.freeze(validateComposition({ learning,
    cognitiveLifecycle: createCognitiveLifecycle({ learningGate: learning }),
    domainIntelligence, knowledgeRoom: createKnowledgeRoom() }));
}
module.exports = { REQUIRED_BINDINGS, validateComposition, createAcceptedComposition };
