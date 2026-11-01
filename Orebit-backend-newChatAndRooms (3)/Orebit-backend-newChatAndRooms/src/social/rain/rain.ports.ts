import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../../../db/client';
import { rainDevWallet } from './rain.dev';
import { parseMinor } from './rain.math';

/**
 * ═══ FACTS RAIN DOES NOT OWN ═════════════════════════════════════════════════
 *
 * Like chat.ports.ts: rain calls these and owns none of them. A module binds its provider in the chat module
 * (`{ provide: RAIN_PRICE_PORT, useExisting: PriceConversionProvider }`) and nothing else in rain changes.
 *
 *  - Price: the USD price of one unit of a currency. The RainPool sheets set amounts in USD ("Rain Amount: Minimum
 *    x USD", "amount above x USD", "X for every y$"). Not connected = only the development rates in
 *    `rain.dev_prices` while RAIN_DEV_WALLET is on; otherwise every USD rule refuses (nothing is guessed).
 *  - Network: whether an IP is a VPN or a proxy ("New IP and Different country (VPN / Proxy)"). Not connected = only
 *    the edge's Tor flag counts.
 */

export interface RainPricePort {
  /** The USD price of one whole unit, as a decimal string, or null when unknown. */
  usdPrice(currency: string): Promise<string | null>;
}

export interface RainNetworkPort {
  /** True for a VPN or proxy address, false for a normal one, null when the provider cannot tell. */
  isVpnOrProxy(ip: string): Promise<boolean | null>;
}

export const RAIN_PRICE_PORT = Symbol('RAIN_PRICE_PORT');
export const RAIN_NETWORK_PORT = Symbol('RAIN_NETWORK_PORT');

@Injectable()
export class RainPorts {
  private readonly logger = new Logger('RainPorts');

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(RAIN_PRICE_PORT) private readonly price?: RainPricePort,
    @Optional() @Inject(RAIN_NETWORK_PORT) private readonly network?: RainNetworkPort,
  ) {}

  /** Whether USD rules can be answered at all: a bound price provider, or the development rates. */
  pricesAvailable(): boolean {
    return this.price !== undefined || rainDevWallet();
  }

  /** The USD price of one whole unit in minor units (8 decimals), or null when unknown. */
  async usdPrice(currency: string): Promise<bigint | null> {
    try {
      if (this.price) {
        const text = await this.price.usdPrice(currency);
        const value = text === null ? null : parseMinor(text);
        return value !== null && value > 0n ? value : null;
      }
      if (!rainDevWallet()) return null;
      const rows = await this.prisma.$queryRaw<{ usd_price: string }[]>`
        SELECT usd_price::text AS usd_price FROM rain.dev_prices WHERE currency = ${currency}
      `;
      const value = rows[0] ? parseMinor(trimDecimal(rows[0].usd_price)) : null;
      return value !== null && value > 0n ? value : null;
    } catch (err: unknown) {
      this.logger.warn({ currency, err }, 'could not read a USD price for rain');
      return null;
    }
  }

  /** The edge's flag, or a connected provider's answer. A provider failure counts as not flagged. */
  async isVpnOrProxy(ip: string, edgeFlag: boolean): Promise<boolean> {
    if (edgeFlag) return true;
    if (!this.network) return false;
    try {
      return (await this.network.isVpnOrProxy(ip)) === true;
    } catch (err: unknown) {
      this.logger.warn({ err }, 'VPN / proxy check failed; the edge flag alone decides');
      return false;
    }
  }
}

/** NUMERIC text like "65000.12000000" → at most 8 decimals, no trailing zeros. */
function trimDecimal(text: string): string {
  const [whole, frac = ''] = text.trim().split('.');
  const kept = frac.slice(0, 8).replace(/0+$/, '');
  return kept ? `${whole}.${kept}` : whole!;
}
