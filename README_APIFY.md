# Apify MCP Server Skeleton

**Production-ready skeleton for building MCP servers powered by Apify Actors**

## 🎯 What's Included

This skeleton implements the complete 3-part Apify deployment pattern:

1. ✅ **Tool Facade** - Simple tools that hide complex Actor inputs (single-item design)
2. ✅ **DO Semaphore** - Fast Fail at 32 concurrent runs (CRITICAL)
3. ✅ **Hot Cache** - 15-minute KV cache (50-70% cost reduction)

Plus flat token pricing: Success = flat cost, failure = 0 tokens. Single-item design enables deep AI analysis (Analyst mode) instead of shallow lists (Aggregator mode).

## 🚀 Quick Start

```bash
# 1. Setup
cd mcp-server-skeleton-apify
npm install

# 2. Set secrets
echo "apify_api_..." | wrangler secret put APIFY_API_TOKEN
echo "client_01K..." | wrangler secret put WORKOS_CLIENT_ID
echo "sk_live_..." | wrangler secret put WORKOS_API_KEY

# 3. Test TypeScript
npx tsc --noEmit

# 4. Deploy (push to GitHub, auto-deploys via Cloudflare)
git push origin main
```

## 📊 Execution Flow (CRITICAL ORDER)

```
1. Check token balance (flat cost)
2. Check cache (KV) ← BEFORE semaphore!
3. If cache HIT: Charge cache cost → Return instantly (skip semaphore)
4. If cache MISS: Check semaphore (DO) - Fast Fail if full
5. Execute Apify Actor
6. Extract single result (results.items[0] || null)
7. Security processing (sanitizeOutput + redactPII)
8. Charge flat cost (success only, 0 for failure)
9. Cache result (15min)
10. Release semaphore (always in finally)
11. Return result
```

**Why cache before semaphore?** Cache check is instant (10ms vs 30-120s Actor execution). Prevents double-charging (cache cost only, not cache + execution cost). Semaphore slots are precious (only 32) - never waste them on cached data!

## 💰 Flat Pricing Example

```typescript
const FLAT_COST = 6;  // tokens per successful call
const CACHE_COST = 6; // same cost for cached results (100% Paid Cache model)

// Step 1: Check balance (flat cost)
const balanceCheck = await ensureMinimumBalance(
  env.TOKEN_DB, userId, FLAT_COST
);
// User needs 6 tokens for this call

// Step 2: Check cache (BEFORE semaphore!)
const cached = await getCachedApifyResult(env.APIFY_CACHE, cacheKey);
if (cached) {
  await consumeTokensWithRetry(env.TOKEN_DB, userId, CACHE_COST, ...);
  return cached; // 10ms response time ⚡
}

// Step 3-5: Acquire semaphore → Execute Actor → Extract result
const result = results.items[0] || null;

// Step 6: Charge flat cost (success only, 0 for failure)
const actualCost = result ? FLAT_COST : 0;
if (result) {
  await consumeTokensWithRetry(env.TOKEN_DB, userId, actualCost, ...);
}
// Success = 6 tokens (fresh: 30-120s, cached: 10ms ⚡)
// Failure = 0 tokens ← Perfect margin protection!
// Benefit: Same cost, 3000x faster for cache hits (70% hit rate)
```

## 🏗️ Architecture

| Component | File | Purpose |
|-----------|------|---------|
| ApifySemaphore | `apify-semaphore.ts` | Enforces 32-run limit |
| ApifyClient | `apify-client.ts` | Calls Actors synchronously |
| KV Cache | `apify-cache.ts` | 15min hot cache |
| Flat Tokens | `tokenConsumption.ts` | Flat pricing (success/failure) |

## 📝 Example Tool Implementation

See the Facebook Page Profiler example in the full README for complete implementation with:
- Single-item input design (enables deep AI analysis)
- Flat pricing (6 tokens/page, success/failure)
- Cache-before-semaphore pattern (50-70% savings)
- Always-release-slot pattern (prevents leaks)

## ⚠️ Critical Rules

1. **Single-Item Inputs** - Accept one item per call (`pageUrl: string`, not `pageUrls: array`)
2. **Cache BEFORE Semaphore** - Never waste slots on cached data
3. **Always Release Slot** - Use `try/finally` block
4. **Flat Pricing** - Success = flat cost, failure = 0 tokens
5. **Extract Single Result** - `results.items[0] || null`

## 📚 Full Documentation

This README is abbreviated. For complete details see:
- Full README in this directory (all examples, troubleshooting)
- `/apify_docs.md` - 3-part pattern details (single-item design)
- `/development_guide.md` - MCP development guide

## ✅ Deployment Checklist

- [ ] Apify API token set (`APIFY_API_TOKEN`)
- [ ] WorkOS secrets configured
- [ ] TypeScript compiles (`npx tsc --noEmit`)
- [ ] Class names updated (ApifySkeletonMCP → YourMCP)
- [ ] Tools implement cache-before-semaphore pattern
- [ ] Single-item extraction (`results.items[0] || null`)
- [ ] Flat pricing implemented (success = flat cost, failure = 0)
- [ ] Semaphore released in finally blocks
- [ ] Git pushed (triggers auto-deploy)

---

**Ready?** Customize this skeleton and start building Apify-powered MCP tools!
