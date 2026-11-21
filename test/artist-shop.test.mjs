import test from 'node:test';
import assert from 'node:assert/strict';
import {artistStoreDomain,shopCollectionsWithKv,shopProductsWithKv} from '../src/lib/artist-shop.ts';
import {productUrl,productPrice} from '../src/lib/shopify.ts';
const response=data=>new Response(JSON.stringify(data));
test('store validation permits artist Shopify shops and rejects arbitrary destinations',()=>{
 for(const host of ['crashdiet.myshopify.com','other-artist.myshopify.com','shop.ninetone.com'])assert.equal(artistStoreDomain(host),host);
 for(const host of ['localhost','127.0.0.1','evil.invalid','x.myshopify.com.evil.invalid','x.myshopify.com:443','https://x.myshopify.com',null])assert.equal(artistStoreDomain(host),null);
});
test('public collections are paginated, associated with their store, and never receive Admin credentials',async()=>{
 const calls=[];let page=0;
 const collections=await shopCollectionsWithKv('test-pagination.myshopify.com',null,async(url,opts)=>{
  calls.push([url,opts]);page++;
  return response({collections:page===1?Array.from({length:250},(_,i)=>({id:i+1,title:'Collection '+i,handle:'item-'+i})):[{id:999,title:'Last',handle:'last'}]});
 });
 assert.equal(collections.length,251);assert.equal(collections.at(-1).url,'https://test-pagination.myshopify.com/collections/last');
 assert.equal(calls.length,2);for(const[,opts]of calls){assert.deepEqual(opts.headers,{Accept:'application/json'});assert.equal(opts.redirect,'error')}
});
test('invalid hosts do not make any network requests',async()=>{
 const no=()=>{throw Error('unexpected')};assert.deepEqual(await shopCollectionsWithKv('evil.invalid',null,no),[]);
 assert.deepEqual(await shopProductsWithKv('evil.invalid',{id:'1',handle:'x'},8,null,no),[]);
});
test('products retain their shop and explicit currency; unpublished products are excluded',async()=>{
 const host='currency-test.myshopify.com';const collection={id:'123',handle:'music'};const calls=[];
 const product={id:1,title:'Album',handle:'album',published_at:'2026-01-01',variants:[{price:'19.95'}],images:[]};
 const result=await shopProductsWithKv(host,collection,8,null,async(url,opts)=>{
  calls.push([url,opts]);return response(url.endsWith('/cart.js')?{currency:'EUR'}:{products:[product,{...product,id:2,published_at:null}]});
 });
 assert.equal(result.length,1);assert.equal(productUrl(result[0]),'https://currency-test.myshopify.com/products/album');
 assert.match(productPrice(result[0]),/19,95/);assert.match(productPrice(result[0]),/€/);
 assert.equal(productPrice({...result[0],currency:undefined}),'');
 for(const[,opts]of calls)assert.equal(opts.headers['X-Shopify-Access-Token'],undefined);
});
test('products and collections are scoped by storefront in the cache',async()=>{
 const calls=[];const fetcher=async url=>{calls.push(url);return response({collections:[{id:123,title:'Shop',handle:'shop'}]})};
 await shopCollectionsWithKv('cache-one.myshopify.com',null,fetcher);await shopCollectionsWithKv('cache-two.myshopify.com',null,fetcher);
 assert.equal(calls.length,2);assert.notEqual(calls[0],calls[1]);
});
test('Shopify rate limiting fails without returning products from a different shop',async()=>{
 await assert.rejects(shopProductsWithKv('limited.myshopify.com',{id:'123',handle:'music'},8,null,async()=>new Response('',{status:429})),/429/);
});
