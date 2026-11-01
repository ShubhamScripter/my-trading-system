import { Global, Module } from '@nestjs/common';
import { NullGeoResolver } from './geo.service';
import { GEO_RESOLVER } from './geo.types';

@Global()
@Module({
  providers: [{ provide: GEO_RESOLVER, useClass: NullGeoResolver }],
  exports: [GEO_RESOLVER],
})
export class GeoModule {}
