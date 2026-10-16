'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { HostRouter } = require('../runtime/host-router.cjs');

test('capability routing is JIT and existing session remains pinned to owner host', () => {
  const owners = new Map([['ses-1', 'P341_HOST_01']]);
  const router = new HostRouter({ sessionOwnerLookup: id => owners.get(id) });
  router.update([
    { hostId:'HOME_HOST_01', transportOnline:true, authorityEligible:true, hostControlEligible:true, capabilities:['WINDOWS','GOVERNED_HOST_CONTROL'], locality:'HOME', headroom:0.4, load:0.2 },
    { hostId:'P341_HOST_01', transportOnline:true, authorityEligible:true, hostControlEligible:true, capabilities:['WINDOWS','GOVERNED_HOST_CONTROL','GPU'], locality:'LAN', headroom:0.8, load:0.1 },
    { hostId:'MSI_HOST_01', transportOnline:false, authorityEligible:true, hostControlEligible:true, capabilities:['WINDOWS','GPU','GOVERNED_HOST_CONTROL'], headroom:1, load:0 }
  ]);
  const selected = router.select({ requiredCapabilities:['GPU','GOVERNED_HOST_CONTROL'] });
  assert.equal(selected.hostId, 'P341_HOST_01');
  const pinned = router.select({ sessionId:'ses-1', requiredCapabilities:['GPU'] });
  assert.equal(pinned.status, 'SESSION_PINNED');
  assert.equal(pinned.hostId, 'P341_HOST_01');
  assert.equal(pinned.movable, false);
});

test('host selection fails closed when current authority or Host Control eligibility is missing', () => {
  const router = new HostRouter();
  router.update([{hostId:'X',transportOnline:true,authorityEligible:true,capabilities:['GOVERNED_HOST_CONTROL']}]);
  assert.equal(router.select({requiredCapabilities:['GOVERNED_HOST_CONTROL']}).status,'NO_ELIGIBLE_HOST');
});
