import assert from 'node:assert/strict';
import test from 'node:test';
import {buildWalletCoreAdminAuditEvent} from './admin-audit.payloads.js';
import type {WalletCoreAdminAuditInput} from './admin-audit.types.js';
const id='01990000-0000-7000-8000-000000000001';
const warning=(state:Record<string,unknown>)=>({domain:'WALLET_CORE',action:'RECONCILIATION.WARNING_CLEARED',
  eventKey:`reconciliation-null:${JSON.stringify(state)}`,actor:{kind:'SYSTEM',runId:id},subject:{type:'CURRENCY',id},
  reason:'Reconciliation warning recovered.',before:null,after:state,metadata:{reconciliationRunId:id}} as WalletCoreAdminAuditInput);
test('permits null shortfall for complete inactive zero-denominator reconciliation states',()=>{
  assert.doesNotThrow(()=>buildWalletCoreAdminAuditEvent(warning({active:false,partial:false,shortfallPercent:null})));
  assert.doesNotThrow(()=>buildWalletCoreAdminAuditEvent(warning({active:false,partial:true,shortfallPercent:null})));
});
test('does not allow complete active or unspecified-active warnings to carry a null percentage',()=>{
  assert.throws(()=>buildWalletCoreAdminAuditEvent(warning({active:true,partial:false,shortfallPercent:null})),/ADMIN_AUDIT_INPUT_INVALID/);
  assert.throws(()=>buildWalletCoreAdminAuditEvent(warning({partial:false,shortfallPercent:null})),/ADMIN_AUDIT_INPUT_INVALID/);
});
