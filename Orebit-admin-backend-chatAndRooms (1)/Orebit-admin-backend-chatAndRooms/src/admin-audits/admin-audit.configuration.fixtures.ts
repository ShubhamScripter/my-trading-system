import { walletCorePatchSchema } from '../wallet/core/wallet-core.dto.js';

/** Pass real transport validation; Audit must retain the accepted timestamp text exactly. */
export function walletAuditTimestampConfig(instant: string) {
  return walletCorePatchSchema.parse({ action:'PUSH',expectedRevision:0,reason:'Timestamp audit regression',config:{currencies:[{
    id:'01920000-0000-7000-8000-000000000021',symbol:'TIME',name:'Timestamp currency',providerRefs:[],
    viewEnabled:false,geoCountryDeny:[],geoContinentDeny:[],accessLevel:'ALL',availableFor:'BOTH',
    listingKind:'TIME_LIMITED',listingStartsAt:instant,showBeforeListing:false,
    premiumEarlyAccessAt:instant,premiumOperations:['DEPOSIT'],soEarlyAccessAt:instant,soOperations:['DEPOSIT'],
    delistAt:instant.replace('2026-09-11','2026-09-12'),postDelistOperations:[],desiredState:'OFF',
    maintenanceAudiences:[],showBalanceInMaintenance:{USER:false,SO:false},bindings:[],
  }]}}).config;
}

/** A complete safe Wallet patch within 64 KiB of the 16 MiB request ceiling. */
export function largeWalletAuditConfig() {
  const addresses = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => `${prefix}-${String(index).padStart(5,'0')}-`.padEnd(256,'a'));
  const binding = (index: number, full: boolean) => ({
    id: `01920000-0000-7000-8000-00000000000${index + 1}`,
    chainId: `01920000-0000-7000-8000-00000000001${index + 1}`,
    providerCoinId: index + 1, blockchainReference: 'coin-' + index,
    isToken: false, blockchainPrecision: 8, desiredState: 'OFF',
    hotWalletAddresses: addresses(index + '-hot',full ? 10000 : 4600),
    coldWalletAddresses: full ? addresses(index + '-cold',10000) : [],
    stakingWalletAddresses: full ? addresses(index + '-stake',10000) : [],
  });
  return { currencies: [{
    id: '01920000-0000-7000-8000-000000000021', symbol:'TEST',name:'Test currency',providerRefs:[],
    viewEnabled:false,geoCountryDeny:[],geoContinentDeny:[],accessLevel:'ALL',availableFor:'BOTH',
    listingKind:'PERMANENT',showBeforeListing:false,premiumOperations:[],soOperations:[],postDelistOperations:[],
    desiredState:'OFF',maintenanceAudiences:[],showBalanceInMaintenance:{USER:false,SO:false},
    bindings:[binding(0,true),binding(1,true),binding(2,false)],
  }] };
}
