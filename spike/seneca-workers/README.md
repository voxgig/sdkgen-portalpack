# Spike: Seneca on Cloudflare Workers with D1

This is throwaway code for Phase 0.1 of
[docs/design/devapi.md](../../docs/design/devapi.md). It answers one question:
can Seneca 4 and seneca-entity run inside an Astro Worker against D1?

They can. The findings are in the design document, under
[Appendix A](../../docs/design/devapi.md#appendix-a-spike-01-seneca-on-workerd).
Delete this folder when Phase 1 lands.

## Run it

```bash
npm install
npx astro build
npx wrangler d1 migrations apply DEVAPI_DB --local --persist-to .state
npx wrangler dev --config dist/server/wrangler.json --persist-to .state --port 8787
```

Then, in another shell:

```bash
B=http://127.0.0.1:8787
curl -H 'x-account: a1' $B/planet                       # 403 account_not_initialised
curl -X POST -H 'content-type: application/json' \
  -d '{"account_id":"a1"}' $B/init                      # copies the seed for a1
curl -H 'x-account: a1' $B/planet                       # the seed, as a1's copy
curl -X PATCH -H 'x-account: a1' -H 'content-type: application/json' \
  -d '{"name":"Terra"}' $B/planet/earth                  # a1 only
curl -X POST -H 'content-type: application/json' \
  -d '{"account_id":"a1","reset":true}' $B/init         # back to the seed
```

## What is here

| file | stands in for |
|---|---|
| `src/lib/d1store.ts` | the D1 driver planned for `@seneca/sqlite-store` (equality queries only) |
| `src/lib/devapi-data.ts` | the generated `sys:devapi-data` plugin: explicit per-account init, and CRUD scoped to one account |
| `src/lib/seneca.ts` | the generated Seneca setup: plugins passed as objects, the store bound to `env` from `cloudflare:workers`, started lazily once per isolate |
| `src/pages/planet/*.ts` | the generated file-per-route Astro endpoints |
| `src/pages/init.ts` | the programmatic init call (spike only; not an HTTP route in the plan) |

The `x-account` header stands in for a verified API key.
