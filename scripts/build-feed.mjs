#!/usr/bin/env node
// Google Merchant Center 用 商品フィード生成スクリプト（Node 20+ 標準モジュールのみ）
//
// 使い方:
//   node scripts/build-feed.mjs [--out feed.xml] [--summary feed-summary.json]
//                               [--collections タイヤ,ホイール] [--max-pages N]
//
// Shopify 公開ストアフロントの products.json（認証不要）から単品（タイヤ・ホイール）を取得し、
// RSS 2.0 形式の feed.xml と集計 feed-summary.json をアトミックに書き出す。
// 取得に失敗したら何も書かずに非0で終了する（前回のファイルを壊さない）。

import { writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  STORE_URL,
  DEFAULT_ID_TEMPLATE,
  productToItems,
  buildFeedXml,
  validateFeedXml,
} from './lib/feed.mjs';

// ---------------------------------------------------------------------------
// 設定（必要ならここを変える）
// ---------------------------------------------------------------------------

/** g:id の書式。Shopify 公式 Google 連携と同じ形式にしておくと、切替時に商品履歴を引き継げる */
const ID_TEMPLATE = DEFAULT_ID_TEMPLATE; // 'shopify_JP_{product_id}_{variant_id}'

/** 取得対象コレクションのハンドル（既定） */
const DEFAULT_COLLECTIONS = ['タイヤ', 'ホイール'];

/** 1ページあたりの取得件数（Shopify の上限 250） */
const PAGE_LIMIT = 250;

/** 各リクエスト後に待つ時間（2リクエスト/秒以内） */
const REQUEST_INTERVAL_MS = 500;

/** 再試行の待ち時間（指数バックオフ・最大5回） */
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];

/** User-Agent */
const USER_AGENT = 'AllTerrainFeedBuilder/1.0 (+https://all-terrain-tireshop.com)';

/** feed-summary.json に載せる skipped の先頭件数 */
const SKIPPED_SAMPLE = 50;

// ---------------------------------------------------------------------------
// 引数
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    out: 'feed.xml',
    summary: 'feed-summary.json',
    collections: DEFAULT_COLLECTIONS,
    maxPages: Infinity,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} に値がありません`);
      return v;
    };
    if (a === '--out') args.out = next();
    else if (a === '--summary') args.summary = next();
    else if (a === '--collections') {
      args.collections = next()
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (a === '--max-pages') {
      const n = Number(next());
      if (!Number.isInteger(n) || n < 1) throw new Error('--max-pages は 1 以上の整数');
      args.maxPages = n;
    } else if (a === '--help' || a === '-h') {
      console.log(
        'usage: node scripts/build-feed.mjs [--out feed.xml] [--summary feed-summary.json] [--collections タイヤ,ホイール] [--max-pages N]',
      );
      process.exit(0);
    } else throw new Error(`不明な引数: ${a}`);
  }
  return args;
}

// ---------------------------------------------------------------------------
// 取得
// ---------------------------------------------------------------------------

/** 1回の GET（JSON）。429/5xx/ネットワーク失敗は指数バックオフで再試行し、それでも駄目なら throw */
export async function fetchJsonWithRetry(url, { fetchImpl = fetch, log = console.error } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
      if (res.ok) return await res.json();
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status} ${url}`);
      } else {
        // 4xx（429以外）は再試行しても変わらないので即失敗
        throw new Error(`HTTP ${res.status} ${url}`);
      }
    } catch (e) {
      if (/^HTTP 4\d\d /.test(String(e?.message)) && !/^HTTP 429 /.test(String(e?.message))) throw e;
      lastErr = e;
    }
    if (attempt < RETRY_DELAYS_MS.length) {
      const wait = RETRY_DELAYS_MS[attempt];
      log(`[retry ${attempt + 1}/${RETRY_DELAYS_MS.length}] ${lastErr.message} → ${wait}ms 待って再試行`);
      await sleep(wait);
    }
  }
  throw new Error(`取得失敗（再試行上限）: ${lastErr?.message ?? url}`);
}

/** コレクション1つの全ページを取得して product 配列を返す */
export async function fetchCollectionProducts(handle, { maxPages = Infinity, storeUrl = STORE_URL, fetchImpl, log = console.error } = {}) {
  const products = [];
  for (let page = 1; page <= maxPages; page++) {
    const url = `${storeUrl}/collections/${encodeURIComponent(handle)}/products.json?limit=${PAGE_LIMIT}&page=${page}`;
    const json = await fetchJsonWithRetry(url, { fetchImpl, log });
    const list = Array.isArray(json?.products) ? json.products : [];
    log(`[fetch] ${handle} page=${page} products=${list.length}`);
    await sleep(REQUEST_INTERVAL_MS); // 2リクエスト/秒以内
    if (list.length === 0) break;
    products.push(...list);
  }
  return products;
}

/** 全コレクションを直列で取得し product.id で重複排除 */
export async function fetchAllProducts(collections, opts = {}) {
  const byId = new Map();
  for (const handle of collections) {
    const list = await fetchCollectionProducts(handle, opts);
    for (const p of list) {
      if (p && p.id !== undefined && !byId.has(p.id)) byId.set(p.id, p);
    }
  }
  return Array.from(byId.values());
}

// ---------------------------------------------------------------------------
// 変換・集計
// ---------------------------------------------------------------------------

/** product 配列 → { items, skipped } */
export function convertProducts(products) {
  const items = [];
  const skipped = [];
  for (const p of products) {
    const r = productToItems(p, { idTemplate: ID_TEMPLATE, storeUrl: STORE_URL });
    items.push(...r.items);
    skipped.push(...r.skipped);
  }
  return { items, skipped };
}

/** feed-summary.json の内容を作る */
export function buildSummary({ products, items, skipped, generatedAt = new Date() }) {
  const byType = {};
  let inStock = 0;
  let outOfStock = 0;
  let withGtin = 0;
  let multipack = 0;
  for (const it of items) {
    const t = it.product_type || '(不明)';
    byType[t] = (byType[t] ?? 0) + 1;
    if (it.availability === 'in_stock') inStock++;
    else outOfStock++;
    if (it.gtin) withGtin++;
    if (it.multipack) multipack++;
  }
  return {
    generated_at: generatedAt.toISOString(),
    products: products.length,
    items: items.length,
    by_type: { 'タイヤ': byType['タイヤ'] ?? 0, 'ホイール': byType['ホイール'] ?? 0, ...byType },
    in_stock: inStock,
    out_of_stock: outOfStock,
    with_gtin: withGtin,
    multipack,
    skipped_count: skipped.length,
    skipped: skipped.slice(0, SKIPPED_SAMPLE),
  };
}

// ---------------------------------------------------------------------------
// 書き出し（アトミック）
// ---------------------------------------------------------------------------

async function writeAtomic(path, content) {
  const abs = resolve(path);
  await mkdir(dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, abs);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const log = (m) => console.error(m);

  log(`[start] collections=${args.collections.join(',')} maxPages=${args.maxPages === Infinity ? 'all' : args.maxPages}`);
  const products = await fetchAllProducts(args.collections, { maxPages: args.maxPages, log });
  log(`[fetch] 合計 ${products.length} 商品（重複排除後）`);

  const { items, skipped } = convertProducts(products);
  const xml = buildFeedXml(items);

  // 整形式チェック（<item> 開閉数一致・生の & なし・制御文字なし）
  const check = validateFeedXml(xml);
  if (!check.ok) {
    throw new Error(`生成 XML の検証に失敗: ${check.errors.join(' / ')}`);
  }

  const summary = buildSummary({ products, items, skipped });

  // 全件取得・検証が済んでから書く（途中失敗で前回ファイルを壊さない）
  await writeAtomic(args.out, xml);
  await writeAtomic(args.summary, JSON.stringify(summary, null, 2) + '\n');

  log(
    `[done] products=${summary.products} items=${summary.items} タイヤ=${summary.by_type['タイヤ']} ホイール=${summary.by_type['ホイール']} ` +
      `in_stock=${summary.in_stock} out_of_stock=${summary.out_of_stock} with_gtin=${summary.with_gtin} multipack=${summary.multipack} skipped=${summary.skipped_count}`,
  );
  log(`[done] wrote ${resolve(args.out)} , ${resolve(args.summary)}`);
}

// 直接実行されたときだけ main を走らせる（テストから import した場合は走らせない）
const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((e) => {
    console.error(`[error] ${e?.stack ?? e}`);
    process.exit(1);
  });
}
