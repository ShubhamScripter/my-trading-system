const assert = require('node:assert/strict');
const pg = require('pg');
require('tsx/cjs');
const { WalletCoreHistoryRepository } = require('../wallet-core.history-repository.ts');
const { PriceConversionHistoryRepository } = require('../../price-conversion/price-conversion.history-repository.ts');

(async () => {
  const url = new URL(process.env.WP11_SCHEMA_DATABASE_URL);
  assert.equal(url.hostname,'127.0.0.1'); assert.equal(url.port,'55441');
  assert.equal(url.pathname,'/orebit_wallet_pricing_fixes_20260910');
  const client = new pg.Client({connectionString:url.href}); await client.connect();
  try {
    assert.equal((await client.query("SELECT current_setting('cluster_name') cluster")).rows[0].cluster,
      'orebit_wallet_pricing_fixes_20260910');
    await client.query('BEGIN');
    await client.query(`INSERT INTO wallet_core.state_events
      (id,event_type,subject_type,subject_id,actor_id,payload,created_at)
      SELECT ('00000000-0000-7000-8000-'||lpad(n::text,12,'0'))::uuid,
      'CHAIN.STATUS_CHANGED','CHAIN',gen_random_uuid(),gen_random_uuid(),
      '{"before":{"desiredState":"OFF"},"after":{"desiredState":"ON"}}',
      now()-make_interval(secs=>n) FROM generate_series(1,5000) n`);
    const provider=(await client.query("SELECT id FROM price_conversion.price_providers WHERE code='COINGECKO'")).rows[0].id;
    const currency=(await client.query(`INSERT INTO price_conversion.currencies
      (symbol,name,decimals,kind,pricing_status)
      VALUES('WP11HISTORY','History plan fixture',18,'CRYPTO','DISABLED') RETURNING id`)).rows[0].id;
    await client.query(`INSERT INTO price_conversion.price_view_resolutions
      (currency_id,configured_provider_id,reason,status,created_at)
      SELECT $1,$2,'SECONDARY_UNAVAILABLE','UNAVAILABLE',now()-make_interval(secs=>n)
      FROM generate_series(1,5000) n`,[currency,provider]);
    await client.query('ANALYZE wallet_core.state_events');
    await client.query('ANALYZE price_conversion.price_view_resolutions');
    await client.query('ANALYZE price_conversion.price_providers');
    let query;
    const recorder={query:async(sql,values)=>{query={sql,values};return{rows:[]};}};
    await new WalletCoreHistoryRepository({schemas:{wallet:'wallet_core'},transaction:fn=>fn(recorder)}).history({limit:50});
    for (const [name,requested] of [['wallet',query],['pricing',null]]) {
      if (name==='pricing') await new PriceConversionHistoryRepository(recorder).history({limit:50});
      let current=requested??query,firstPage;
      for (const page of [1,2]) {
        const {sql,values}=current;
        const plan=(await client.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${sql}`,values)).rows[0]['QUERY PLAN'][0];
        const result=await client.query(sql,values);
        assert.equal(result.rows.length,51);
        if(page===2){assert.equal(result.rows[0].id,firstPage[50].id);
          assert.ok(!result.rows.some(row=>firstPage.slice(0,50).some(first=>first.id===row.id)));}
        const nodes=[];
        const visit=node=>{nodes.push({type:node['Node Type'],relation:node['Relation Name'],
          index:node['Index Name'],rows:node['Actual Rows'],loops:node['Actual Loops'],sort:node['Sort Key']});
          for(const child of node.Plans??[])visit(child);};
        visit(plan.Plan);
        console.log(JSON.stringify({name,page,rows:result.rows.length,milliseconds:plan['Execution Time'],
          sharedHits:plan.Plan['Shared Hit Blocks'],sharedReads:plan.Plan['Shared Read Blocks'],nodes}));
        if(page===1){firstPage=result.rows;
          // Let the real repository encode its query fingerprint and exact timestamp precision.
          const replay={query:async sql=>sql.startsWith('SET TRANSACTION')?{rows:[]}:result};
          const returned=name==='wallet'
            ? await new WalletCoreHistoryRepository({schemas:{wallet:'wallet_core'},transaction:fn=>fn(replay)}).history({limit:50})
            : await new PriceConversionHistoryRepository(replay).history({limit:50});
          assert.equal(returned.items.length,50);
          assert.equal(typeof returned.nextCursor,'string');
          if(name==='wallet')await new WalletCoreHistoryRepository({schemas:{wallet:'wallet_core'},transaction:fn=>fn(recorder)})
            .history({limit:50,cursor:returned.nextCursor});
          else await new PriceConversionHistoryRepository(recorder).history({limit:50,cursor:returned.nextCursor});
          if(name==='wallet'){assert.match(query.values[0],/\.\d{6}Z$/);
            assert.equal(query.values[0],result.rows[49].created_at);}
          current=query;}
      }
    }
  } finally {await client.query('ROLLBACK');await client.end();}
})().catch(error=>{console.error(error);process.exitCode=1;});
