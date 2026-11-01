import { walletAuditTimestampConfig } from './admin-audit.configuration.fixtures.js';

const id='01920000-0000-7000-8000-000000000001';
const chain={id,providerChainId:1,blockchainReference:'chain-1',name:'Updated chain',shortName:'CHAIN',isEvm:true,availableFor:'BOTH',desiredState:'OFF'};
const currency=walletAuditTimestampConfig('2026-09-11T12:00:00Z').currencies![0]!;

export function scheduledWalletBusinessEvents() {
  return ['CHAIN.UPDATED','CHAIN.IMPORTED','CURRENCY.UPDATED','CURRENCY.IMPORTED','PROVIDER_MAINTENANCE.PINNED','PROVIDER_MAINTENANCE.UNPINNED'].map(action=>({
    domain:'WALLET_CORE',action,eventKey:'scheduled-business:'+action,
    actor:{kind:'SYSTEM',runId:'550e8400-e29b-41d4-a716-446655440000'},
    subject:{type:action.startsWith('CURRENCY.')?'CURRENCY':'CHAIN',id:action.startsWith('CURRENCY.')?currency.id:id},
    reason:'Apply scheduled Wallet business change',
    before:action.endsWith('IMPORTED')?null:action.startsWith('CHAIN.')?{config:{...chain,name:'Earlier chain'}}:action.startsWith('CURRENCY.')?{config:{...currency,name:'Earlier currency'}}:{maintenancePinned:action.endsWith('UNPINNED')},
    after:action.startsWith('CHAIN.')?{config:chain}:action.startsWith('CURRENCY.')?{config:currency}:{maintenancePinned:action.endsWith('.PINNED')},
    metadata:{configurationRevision:1,scheduledChangeId:id},
  }));
}
