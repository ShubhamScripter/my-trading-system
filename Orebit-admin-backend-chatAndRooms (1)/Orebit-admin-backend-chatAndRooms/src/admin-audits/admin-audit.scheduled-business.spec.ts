import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWalletCoreAdminAuditEvent } from './admin-audit.payloads.js';
import { scheduledWalletBusinessEvents } from './admin-audit.scheduled-business.fixtures.js';

for (const input of scheduledWalletBusinessEvents()) {
  test('Scheduled SYSTEM '+input.action+' retains its complete business change and scheduled identity',()=>{
    const result=buildWalletCoreAdminAuditEvent(input as never);
    assert.deepEqual(result.before,input.before); assert.deepEqual(result.after,input.after);
    assert.deepEqual(result.actor,input.actor); assert.deepEqual(result.metadata,input.metadata);
  });
}

test('New SYSTEM business actions require valid schedule and run identities',()=>{
  for(const input of scheduledWalletBusinessEvents()) for(const invalid of [
    {...input,metadata:{configurationRevision:1}},
    {...input,metadata:{...input.metadata,scheduledChangeId:null}},
    {...input,metadata:{...input.metadata,scheduledChangeId:'not-a-uuid'}},
    {...input,actor:{kind:'SYSTEM',runId:'not-a-uuid'}},
  ]) assert.throws(()=>buildWalletCoreAdminAuditEvent(invalid as never),/^Error: ADMIN_AUDIT_INPUT_INVALID$/);
});

test('Manual ADMIN business actions still accept their existing metadata without schedule context',()=>{
  for(const input of scheduledWalletBusinessEvents()) {
    const id=input.metadata.scheduledChangeId;
    const manual={...input,actor:{kind:'ADMIN',actorId:id,sessionId:id,requestId:id,ipAddress:'127.0.0.1',deviceId:'admin-test'},metadata:{configurationRevision:1}};
    assert.deepEqual(buildWalletCoreAdminAuditEvent(manual as never).after,input.after);
  }
});

test('Scheduled context does not permit CREATED actions or unsafe business fields',()=>{
  for(const input of scheduledWalletBusinessEvents().slice(0,4)) {
    const created={...input,action:input.action.startsWith('CHAIN.')?'CHAIN.CREATED':'CURRENCY.CREATED'};
    assert.throws(()=>buildWalletCoreAdminAuditEvent(created as never),/^Error: ADMIN_AUDIT_INPUT_INVALID$/);
    const unsafe={...input,after:{config:{...input.after.config,apiKey:'never-log'}}};
    assert.throws(()=>buildWalletCoreAdminAuditEvent(unsafe as never),/^Error: ADMIN_AUDIT_INPUT_INVALID$/);
  }
});

test('Existing settings envelopes preserve effective normalized settings before and after',()=>{
  const base=scheduledWalletBusinessEvents()[0]!;
  const settings={globalDesiredState:'OFF',catalogueMode:'ALL',reconciliationIncludeTreasury:true,reconciliationIncludeCollection:false,reconciliationAlertBasis:'SIGNED',reconciliationAlertPercent:'5',defaultCurrencyIds:[base.metadata.scheduledChangeId]};
  const input={...base,action:'SETTINGS.SCHEDULE_APPLIED',subject:{type:'SETTINGS_REVISION',id:'1'},
    before:{revision:1,status:'SCHEDULED',effectiveAt:null,config:{settings}},
    after:{revision:1,status:'LIVE',effectiveAt:null,config:{settings:{...settings,reconciliationAlertPercent:'10',defaultCurrencyIds:[]}}},metadata:{configurationRevision:1}};
  const result=buildWalletCoreAdminAuditEvent(input as never);
  assert.deepEqual(result.before,input.before); assert.deepEqual(result.after,input.after);
});
