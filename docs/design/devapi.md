# devapi: mock developer APIs generated from the SDK model

**Status: plan, revised after review.** The rulings are recorded in
[Decisions](#15-decisions), including D17 and D18, which adopt the existing
Seneca Cloudflare packages (§8). Spike 0.1, which asked whether Seneca
runs on Cloudflare Workers, is done and passed
([Appendix A](#appendix-a-spike-01-seneca-on-workerd)). Nothing else is built
yet.

This pack, `@voxgig/sdkgen-portalpack`, adds four targets to the
[Voxgig SDK Generator](https://github.com/voxgig/sdkgen). Together they turn the
API model an SDK is generated from into a working **mock of that API**: an
initial dataset, API keys, and a server that answers the routes the SDK calls.

| target | generates | runs on |
|---|---|---|
| `devapi-data` | The mock dataset, defined in aontu and delivered as committed CSV and JSON, a typed programmatic interface, and the `sys:devapi-data` Seneca plugin that serves a copy of the data to each account. | TypeScript only |
| `devapi-access` | API-key generation and validation, and management of the accounts keys are issued under, as the `sys:devapi-access` Seneca plugin with a programmatic interface. | TypeScript only |
| `devapi-fastify` | A mock server on Fastify for every route in the model. Accounts' data lives in SQLite. | Node 24 |
| `devapi-cloudflare` | The same server on Cloudflare Workers with Astro. Accounts' data lives in D1. | workerd |

**Everything is generated for one API; nothing is a shared runtime library.**

- The business logic is the two generated Seneca plugins. Both servers load
  them unchanged.
- Each server generates only its own HTTP wiring, its request validation and
  its store set-up.
- **One store serves both servers:** `@seneca/cloudflare-d1-store`. Workers
  pass it the D1 binding; Node gets a new `node:sqlite` client (§8). Both
  servers therefore have the same tables, SQL and migrations.
- **The portal's way in** is `@seneca/gateway-cloudflare`, mounted as a
  token-guarded admin endpoint (§4.5).

## Contents

1. [Why four targets, not features](#1-why-four-targets-not-features)
2. [Architecture](#2-architecture)
3. [devapi-data](#3-devapi-data)
4. [devapi-access](#4-devapi-access)
5. [Request handling, shared by both servers](#5-request-handling-shared-by-both-servers)
6. [devapi-fastify](#6-devapi-fastify)
7. [devapi-cloudflare](#7-devapi-cloudflare)
8. [The Seneca Cloudflare packages](#8-the-seneca-cloudflare-packages)
9. [Packages and repositories](#9-packages-and-repositories)
10. [Model options](#10-model-options)
11. [This repository](#11-this-repository)
12. [Testing](#12-testing)
13. [Risks](#13-risks)
14. [Order of work](#14-order-of-work)
15. [Decisions](#15-decisions)
16. [Open questions, non-goals and later work](#16-open-questions-non-goals-and-later-work)
- [Appendix A: spike 0.1, Seneca on workerd](#appendix-a-spike-01-seneca-on-workerd)

---

## 1. Why four targets, not features

An sdkgen package can provide `target`, `feature` and `edition` items
(`ts/src/action/kind.ts` in sdkgen). All four here are **targets**.

- **A feature extends a generated SDK.** It is copied into a target's output
  and runs in the SDK's operation pipeline through hooks. The devapi pieces
  are not part of any SDK pipeline. A feature limited to two server targets
  would also need a new applicability tag, and the tag vocabulary is closed
  (`sekreto` and `schema`).
- **An edition is a documentation build.** That is not what these are. The
  developer and agent portal is a separate repository, `voxgig/portal`.
- **A target fits all four.** They take the consumer-target shape from
  `sdkgen-infrapack`'s `seneca-provider`: every standard phase off, the whole
  package emitted from `Main`, and `parity: CONSUMER`.

**The servers need the other two targets.** No manifest field can say "this
target needs that one", and sdkgen documents that gap as deliberate. So
`devapi-fastify` and `devapi-cloudflare` throw at generation unless
`devapi-data` and `devapi-access` are both in the model, and the README says
so. Neither server needs the `ts` target. When `ts` is present, the Fastify
server's generated suite also drives the generated TypeScript SDK against the
running mock.

---

## 2. Architecture

```
  generation time (sdkgen + this pack)                    run time
 OpenAPI ─apidef─▶ model (.sdk/model/*.aontu)
                     │
                     ├─ devapi-data       ─▶ devapi-data/       data + sys:devapi-data plugin
                     ├─ devapi-access     ─▶ devapi-access/     sys:devapi-access plugin
                     ├─ devapi-fastify    ─▶ devapi-fastify/    ─┐  depend on the two above
                     └─ devapi-cloudflare ─▶ devapi-cloudflare/ ─┘  by file:../ path
                                                                 ▼
     ┌──── generated HTTP layer: Fastify routes | Astro endpoint files ────┐
     │      validate (JSON Schema from the spec), extract the credential   │
     │  Seneca  sys:devapi-access,verify:key ─▶ account_id                 │
     │          sys:devapi-data,entity:<e>,op:<op> ─▶ { status, body }     │
     │  seneca-entity ─▶ @seneca/cloudflare-d1-store:                      │
     │                     node:sqlite client (Fastify) | D1 binding (CF)  │
     └─────────────────────────────────────────────────────────────────────┘
       admin endpoint: @seneca/gateway ─▶ allow-listed sys:devapi-* messages
```

### What each target owns

| owner | owns |
|---|---|
| `devapi-data` | The data definition; the dataset; the per-account copy; every operation's behaviour, including request and response transforms. The plugin takes a wire-shaped body and returns a wire-shaped body, so the servers know nothing about entities. |
| `devapi-access` | Accounts, as opaque ids with a status, and the keys issued under them. Where the credential travels, as the model's security scheme defines it. |
| The servers | Routing, JSON-Schema validation, extracting the credential, mapping the plugins' answers to HTTP, store configuration, the admin endpoint, and serving the API definition. |

**This pack holds the shared generation-time code.** Every target derives from
the same model, so the derivations they share live in one component file in
this repository: routes from points, record keys, and wire placeholders. A
test checks that each target's copy is identical, because sdkgen copies each
target's components into the consumer separately and targets can be aliased.

### The Seneca message surface

| pattern | what it does |
|---|---|
| `sys:devapi-data,init:account` | Copies the seed for an account. `reset: true` discards the account's data and copies the seed again. |
| `sys:devapi-data,remove:account` | Deletes an account's data. |
| `sys:devapi-data,entity:<e>,op:<op>` | List, load, create, update, patch or remove, for one account (§3.6). |
| `sys:devapi-data,entity:<e>,action:<a>` | A custom action route: an alternative point carrying `$action`. |
| `sys:devapi-data,get:info` | The API name and version, the entity list and the data seed. |
| `sys:devapi-access,…` | Accounts and keys (§4.4). |

Customising the mock means overriding one of these patterns with Seneca's
`prior`, in a user-owned `src/custom.ts` that each server emits once and never
overwrites. The same file works on both servers.

---

## 3. devapi-data

### 3.1 The data is defined in aontu; aontu does not generate it

aontu defines, unifies, constrains and validates structures. It deliberately
has **no randomness**: aontu.dev says it has "no user-defined functions,
clock, or randomness". So aontu defines the dataset, and a seeded expander
written in TypeScript generates the records from aontu's resolved output.

The definition has three layers. aontu unifies them rather than letting later
layers overwrite earlier ones:

1. **The derived base**, emitted by `devapi-data` from the model:
   - field types, required fields and nullability;
   - OpenAPI enums and formats, and parameter examples;
   - name heuristics: `email`, `url`, `*_at`, `name`, `title`, and `*_id`
     where an entity of that stem exists.

   Every value in the base is an aontu default (`*`), so a project can
   override it.
2. **The project's overrides**, under `main: kit: target: 'devapi-data'` in
   `.sdk/model/project.aontu`.
3. **Fixed records**, literal records that must exist.

```aontu
main: kit: target: 'devapi-data': {
  seed: 'solar-1'
  entity: planet: {
    count: 12
    field: kind:     gen: pick: ['rock', 'gas', 'ice']
    field: diameter: gen: int: [2000, 150000]
    fixed: earth: { id: 'earth', name: 'Earth', kind: 'rock', diameter: 12756 }
  }
  entity: moon: count: { per: 'planet', min: 0, max: 4 }
}
```

The base carries an OpenAPI enum as a constraint, so an override such as
`pick: ['lava']` does not quietly produce invalid data. aontu reports the
conflict, and names both places it comes from.

### 3.2 Generator vocabulary

| `gen` | value |
|---|---|
| `seq`, `id`, `uuid` | identifiers |
| `int: [min, max]`, `num: [min, max, dp]`, `bool: p` | numbers and booleans |
| `pick: [...]` (optional weights) | an enum member |
| `words: [a, b]`, `text: [a, b]` | lorem text from built-in word lists |
| `name.first`, `name.last`, `name.full`, `email`, `url`, `phone` | person-shaped values; `email` is derived from the same record's name fields |
| `date: [from, to]`, `datetime: [from, to]` | ISO 8601 |
| `ref: <entity>` | the key of an existing record of that entity |
| `tmpl: '{name.first}.{name.last}@example.com'` | a value composed from other fields |
| `const: v`, `null: p`, `omit: p` | a fixed value; nullable; optional and absent |
| `list: {count, of}`, `obj: {…}` | nested arrays and objects |

The core has no faker dependency. `gen: 'faker:…'` is an opt-in bridge that
works when `@faker-js/faker` is installed, seeded from the same stream.

### 3.3 Determinism and referential integrity

- **Each value is a pure function of `(seed, entity, index, field)`.** Adding a
  field or raising a count therefore never reshuffles values that already
  exist.
- **Keys are minted before fields.** Every entity's keys are minted in a first
  pass, and fields are filled in a second. `ref` therefore resolves for
  self-references such as `employee.manager_id`, and for cycles.
- **Child counts need an acyclic parent graph.** `count: { per: … }`
  distributes child records across their parents, so a cycle in that graph is
  rejected at generation, with the cycle named.
- **Every record is validated** against the entity's data spec before it is
  written. The spec is sdkgen's `entityDataSpec`, the same one the generated
  SDK uses.

### 3.4 When the data is generated, and what is output

The data is generated **at sdkgen generation time**, by the target's `Main`, and
committed with the rest of the generated tree. The same seed always produces
the same bytes, and a change to the definition shows up as a reviewable diff.

```
devapi-data/
  package.json                   # <sdk-package>-devapi-data
  model/data.aontu               # the derived base, for reference
  data/spec.json                 # the resolved definition the expander read
  data/json/<entity>.json        # records, keyed by record key
  data/csv/<entity>.csv
  migrations/0001_data.sql       # one table per entity (3.5)
  migrations/0002_seed.sql       # the seed tables, filled with the dataset
  src/plugin.ts                  # sys:devapi-data
  src/index.ts  src/types.ts     # the programmatic interface
  test/
  README.md
```

The CSV follows RFC 4180, in UTF-8 with LF line endings:

- the header row is the field names in model order, with the record key
  first;
- `null` is an empty cell;
- an object or array is JSON text in one cell;
- dates are ISO 8601.

The programmatic interface:

```ts
import { data } from '@acme/solar-sdk-devapi-data'

data.entities()                              // ['moon', 'planet']
data.list('planet', { kind: 'rock' })        // Planet[], in seed order
data.load('planet', 'earth')                 // Planet | undefined
data.csv('planet')                           // string
data.regenerate({ seed: 'x', count: { planet: 100 } })
data.seedFor('sdk-test')                     // the seed shape the TS SDK's test feature reads
```

### 3.5 Each account has its own copy of the data

Each account is given **a full copy of the seed**, and the data API reads and
writes only that copy.

- **The copy is made by an explicit call:**
  `sys:devapi-data,init:account`, or `data.initAccount(id)` in the
  programmatic interface.
- **Until then, the account is refused.** Any data request for the account
  answers 403 with error `account_not_initialised`.
- **`reset: true`** discards the account's copy and makes it again.
- **Who calls it.** In v1, the programmatic interface, the local CLI, or the
  Fastify server's dev-mode bootstrap (§4.6). Later, the portal.

**How it is stored.** The layout is `@seneca/cloudflare-d1-store`'s own: one
table per entity canon, holding `id TEXT PRIMARY KEY` and `data TEXT`, the
record as JSON. It is the same on both servers, because both use that store
(§8).

- **Account tables.** `devapi_<entity>` holds every account's copy. Each row's
  `id` is `<account_id>/<record key>`, which seneca-entity needs to be unique.
  `data` carries `account_id` and `rkey` alongside the fields.
- **Migrations create the tables, and an index on each.** The store creates a
  missing table on first use (`CREATE TABLE IF NOT EXISTS`). The generated
  migrations create the same tables first, each with an expression index on
  `json_extract(data, '$.account_id')`, so that per-account queries do not
  scan every account's rows.
- **Seed tables.** `devapi_seed_<entity>` has the same layout, and is filled
  by the generated `0002_seed.sql` in multi-row inserts chunked to stay inside
  D1's per-statement limits.
- **Initialising an account is one `INSERT … SELECT` per entity.** It copies
  the seed table into the account's rows, rewriting `id` and adding
  `account_id` with `json_set`. It runs through the store's native client
  (`client().run`), so the copy stays on the database side and the Worker
  bundle does not carry the dataset.
- **Lists always pass `limit$`.** The store's default page size is 11.

**The costs of a full copy, stated.**

- **Storage grows with accounts × seed.** A 1 MB seed and 1,000 initialised
  accounts is about 1 GB, which matters against D1's per-database size limit.
  The generated README states the arithmetic, and `limits.accounts` can cap
  the number of initialised accounts.
- **Regenerating the seed changes only the seed tables.** Existing accounts
  keep their copy until they are reset. This is deliberate, because a
  developer's data should not shift under them.

### 3.6 How each operation behaves

Each operation runs inside `sys:devapi-data,entity:<e>,op:<op>`, for one
initialised account. **Request bodies are decoded first**: the plugin applies
the inverse of the route's request transform `t.req`, so it stores records,
not wire envelopes. **Response bodies are encoded last**, wrapped the way
`t.res` unwraps them. The rule matches the TypeScript SDK `test` feature's
`envelope`, and a case table shared with `TestFeature.ts` tests the two
against each other. A transform that cannot be inverted is reported at
generation, and its route answers 501.

| op | behaviour |
|---|---|
| list | The account's records, filtered by parent path parameters and by any query parameter that names a field. Other required parameters, such as `q`, are checked for presence but never filter. Paging applies only where the model configures it (§10). |
| load | The record, or 404. |
| create | The record key is minted, unless the create sends it. A key that already exists answers 409. Read-only fields the request did not send are filled by the entity's generator rules. The status is the spec's success code. |
| update / patch | 404 if the record is absent. Otherwise the decoded body is merged into the record, keeping the key, the parents and read-only fields. `put: replace` makes update replace the record instead. |
| remove | 404 if the record is absent; otherwise the record is deleted. The status is the spec's (200 or 204). |
| action on a record | Loads the record (404 if absent), merges the body, and returns the record. This is the expected place to customise. |
| action on a collection | No record key to load, so it answers 501 and is listed in the README, until a Seneca override implements it. |

---

## 4. devapi-access

API keys for one API. **It is about keys, not users.**

### 4.1 Accounts

An account is **an opaque id with a status**. The caller supplies the id: in
v1 the CLI or a test, later the portal. Keys are issued under the account, and
all of an account's keys see the same copy of the data.

| entity | fields |
|---|---|
| `devapi/account` | `id`, `status` (`active` or `suspended`), `created` |
| `devapi/apikey` | `id` (the key id, `kid`), `account_id`, `name`, `hash`, `status` (`active` or `revoked`), `created`, `expires`, and `last_used`, written at most once an hour per key |

There are no scopes in v1: a valid key gives full access to its account's
data.

### 4.2 Keys

- **Format:** `<prefix>_<kid>_<secret>`.
  - `prefix` is the API slug, so a leaked key is recognisable.
  - `kid` is 12 characters of Crockford base32, stored in clear and used for
    lookup.
  - `secret` is 32 random bytes, base64url-encoded.
- **Storage:** only `HMAC-SHA-256(pepper, secret)` is stored. The pepper is a
  server secret, `DEVAPI_KEY_PEPPER`. The plaintext key is returned once, at
  creation.
- **Why HMAC rather than a slow hash.** The secret has 256 random bits, so a
  slow hash adds nothing, and it would cost CPU on every request, which
  Workers meter.
- **Implementation:** WebCrypto on both platforms. `crypto.subtle.verify`
  compares in constant time.

### 4.3 Verifying a request

1. **Extract the credential** from where the model's security scheme puts it.
   This is resolved through sdkgen's auth helpers (`isAuthActive`,
   `resolveAuthIn`, `resolveAuthName`, `resolveAuthPrefix`), so the generated
   SDK's `apikey` option works against the mock unchanged.
   - v1 supports an API key in a header, query parameter or cookie, and a
     bearer token.
   - HTTP Basic, or a scheme with a token exchange, fails at generation with
     an unsupported-auth error.
2. **Load the key by `kid`**, and check its status and expiry.
3. **Verify the HMAC**, then check the account's status.
4. **Return** `{ account_id, kid }`.

A successful verification is cached per isolate for up to 30 s. The cache
entry keeps the key's `expires` and checks it on every hit, so expiry is
exact. Revocation and suspension can take up to the cache time to apply.

An API whose model declares no authentication gets one implicit account, so
the per-account machinery still runs.

### 4.4 The interface

| pattern | |
|---|---|
| `create:account`, `get:account`, `update:account` (status), `remove:account`, `list:account` | Removing an account revokes its keys. Its data is removed separately, by `sys:devapi-data,remove:account`, because the two plugins stay independent. |
| `generate:key`, `list:key`, `revoke:key`, `rotate:key` | `generate` and `rotate` return the plaintext key once. `list` never returns a secret or a hash. |
| `verify:key` | Takes a raw credential and returns `{ ok, account_id }` or `{ ok: false, why }`. |

The generated `devapi-access/` package wraps these in a typed facade
(`access.createAccount(…)`, `access.generateKey(…)`, `access.verify(…)`). It
also provides the migrations for its two tables, and a **local CLI** over the
facade, which works directly on a SQLite file.

### 4.5 The admin endpoint: how the portal reaches a deployed server

`voxgig/portal` creates accounts, initialises their data, and issues and
revokes keys by **sending Seneca messages over HTTP** to one admin endpoint
on each server. That endpoint is `@seneca/gateway`'s transport-agnostic
handler. On Workers it is mounted through `@seneca/gateway-cloudflare`.

- **Path.** `/devapi-admin` by default, set by `admin.path`. It cannot start
  with `_`, which Astro excludes from file routing. Generation refuses a model
  route that collides with it.
- **Allow list.** The gateway's `allow` option admits only:
  - `sys:devapi-access` messages;
  - `sys:devapi-data,init:account` and `sys:devapi-data,remove:account`.

  Data operations stay behind the API routes and their keys.
- **Service token.** Every call carries `Authorization: Bearer
  $DEVAPI_ADMIN_TOKEN`. The generated server checks the token, in constant
  time, before it hands the request to the gateway. `@seneca/gateway-auth` has
  no bearer spec for Cloudflare, only its cookie helper. With no token set,
  the endpoint answers 404.
- **No CORS.** The gateway's default `Access-Control-Allow-Origin: *` is
  overridden. The portal calls from its server, not from a browser.
- **Both servers.** Fastify mounts the same handler on the same path, so the
  portal talks to either server the same way.

For local work there is also the CLI over the programmatic interface (§4.4).
Pointed at a deployed database through the D1 store's REST mode, it is an
operator's fallback that needs no admin endpoint.

### 4.6 A key for local live tests

In dev mode, the Fastify server gives a `dev` account a stable key and
initialises its data.

- The key is `<ENV>_APIKEY`, when that is set and well formed.
- Otherwise the server creates one on first start, writes it to the
  gitignored `.devapi/dev.env`, and reuses it on later starts.
- The generated `test:sdk` script loads that file.
- In CI, the job sets `<ENV>_APIKEY` (`npm run dev-key` prints a well-formed
  one).

---

## 5. Request handling, shared by both servers

Each server generates this flow for every active point in the model:

1. **Route.** The method and the wire path come from the point (`m`, and `o`
   with its placeholders).
2. **Validate** against the **spec's own JSON Schemas**: path, query and
   header parameters, and the request body. They come from apidef's resolved
   definition through `pointFacts(ctx$, point)`, with `$ref`s already resolved
   and cycles bounded by `boundedFacts`. Validation sees the wire format,
   which is what the spec describes. A failure answers 400.
3. **Authenticate** with `sys:devapi-access,verify:key`. A failure answers 401,
   with the `WWW-Authenticate` header that matches the scheme.
4. **Run the operation** with
   `sys:devapi-data,entity:<e>,op:<op> { account_id, params, query, body }`.
   This returns `{ status, body }`, already wire-shaped (§3.6).
5. **Reply.**

Every error answers `{ statusCode, error, message }`.

| status | when |
|---|---|
| 400 | validation failed |
| 401 | the credential is missing or invalid |
| 403 | the account is suspended or not initialised |
| 404 | the route or the record does not exist |
| 409 | the record key already exists |
| 413 | an account limit was reached |
| 501 | a GraphQL point, a raw body, a transform that cannot be inverted, or a collection action not yet overridden |

**Paging** happens only where the model names the paging parameters (§10).
Without that, a list returns every record the account has.

**The API definition is served read-only**, at `/openapi.json` (or `.yaml`,
matching the source).

- The file the SDK was built from is copied into the generated server. Its
  path comes from the build's `def` setting, which is to be confirmed in
  Phase 1.
- Copying the file is not reading API shape from it, so this stays within
  ADR-001.
- If the model has its own route at that path, generation warns and skips the
  copy.

---

## 6. devapi-fastify

```
devapi-fastify/
  package.json            # fastify 5; seneca 4 rc; seneca-entity; seneca-promisify;
                          # @seneca/cloudflare-d1-store; @seneca/gateway;
                          # file:../devapi-data; file:../devapi-access
  src/server.ts           # build and listen
  src/routes.ts           # one Fastify route per point, with its JSON Schemas
  src/admin.ts            # the admin endpoint (4.5)
  src/seneca.ts           # store (node:sqlite client) + access + data + custom
  src/custom.ts           # user-owned
  openapi.json            # the copied definition
  test/server.test.ts     # node:test with fastify.inject
  test/sdk.test.ts        # only when the ts target exists: the SDK against the mock
  README.md  .gitignore  tsconfig.json
```

- **Validation** is Fastify's own: each route declares the spec's schemas, and
  Fastify validates them with ajv. The ajv options match the Cloudflare
  server's (§7), so the two servers accept and reject the same requests.
- **Storage** is `@seneca/cloudflare-d1-store` with its new `node:sqlite`
  client, in `.devapi/devapi.sqlite`.
  - The migrations are the same files the Cloudflare server applies with
    wrangler. Here they are applied at startup and tracked in a
    `d1_migrations` table, the way wrangler tracks them.
  - `npm run db:reset` deletes the file.
- **Sibling packages.**
  - The dependencies on `devapi-data` and `devapi-access` are `file:` paths.
    They are computed from those targets' actual output locations, so they
    stay correct if `output.path` moves either one.
  - `npm run build` builds the siblings first.
  - A server generated into another repository breaks those paths, and
    generation warns.
- **Port.** The default is 8901, matching sdkgen's hand-written solardemo
  server. A project can generate this server into the SDK repo's `app/` with
  `output: path: 'app'`, to stand in for that companion server in live tests
  (§4.6).

---

## 7. devapi-cloudflare

```
devapi-cloudflare/
  package.json            # astro, @astrojs/cloudflare, wrangler; seneca 4 rc; seneca-entity;
                          # seneca-promisify; @seneca/cloudflare-d1-store; @seneca/gateway;
                          # @seneca/gateway-cloudflare; file: siblings
  astro.config.mjs        # output: 'server', adapter: cloudflare({...})
  wrangler.jsonc          # nodejs_compat; d1_databases: DEVAPI_DB; migrations_dir
  migrations/             # devapi-data's and devapi-access's, gathered at generation
  src/pages/<route>.ts    # one endpoint file per path, exporting its methods
  src/pages/devapi-admin.ts   # the admin endpoint (4.5)
  src/pages/openapi.json.ts
  src/validate/*.js       # ajv-standalone validators, precompiled at sdkgen generation
  src/lib/seneca.ts       # lazy, once-per-isolate Seneca with the D1 store
  src/custom.ts           # user-owned
  test/worker.test.ts     # node:test driving the built Worker under wrangler dev / Miniflare
  README.md
```

- **One endpoint file per route.**
  - A path such as `/planet/{id}` becomes `src/pages/planet/[id].ts`,
    exporting `GET`, `PATCH` and `DELETE`, as the spike did.
  - Two paths that differ only in a parameter's name at the same position
    cannot both be Astro files. Those fall back to one generated catch-all
    `[...path].ts`, with a small route table, and generation warns.
  - Astro excludes paths that begin with `_` from file routing, so a model
    route like that also goes through the catch-all.
- **Validation** uses ajv-standalone modules generated at sdkgen time. ajv's
  runtime compiles validators with `new Function`, which workerd forbids, so
  this pack depends on `ajv` and `ajv-formats` at generation. The options are
  the same as the Fastify server's.
- **Bindings and start-up.** Bindings are read with
  `import { env } from 'cloudflare:workers'`. Seneca starts on the first
  request and is reused for the isolate's lifetime. Plugins are passed as
  objects, not names, and seneca-entity takes `mem_store: false`
  (Appendix A).
- **The D1 binding is wrapped in tests.** The D1 store's README notes that
  Miniflare's `D1Database` is a Proxy, which can trip Seneca's option merge.
  Generated tests pass a plain `{ prepare, batch, exec }` wrapper.
- **Adapter defaults are turned off.** `@astrojs/cloudflare` adds a `SESSION`
  KV binding and an `IMAGES` binding by default (Appendix A). The generated
  config disables both, so deploying needs only D1.
- **Local development.** `npm run dev` runs `astro dev` on workerd with a local
  D1. In Astro 7 that starts as a daemon, stopped with `astro dev stop`. The
  generated scripts and tests account for that.
- **Deployment.**
  1. Create the database with `wrangler d1 create`, and put its id in the model
     (`devapi-cloudflare: d1: database_id`). Generation overwrites
     `wrangler.jsonc`, so the id cannot live there.
  2. Set `DEVAPI_KEY_PEPPER` and `DEVAPI_ADMIN_TOKEN` with
     `wrangler secret put`.
  3. Run `npm run deploy`. It runs `astro build` first, then the remote
     migrations, then `wrangler deploy`. Migrations are additive only (expand
     now, contract in a later release), because the running Worker must keep
     working against the new schema.

---

## 8. The Seneca Cloudflare packages

Five `senecajs` packages already exist for Cloudflare. Two are used in v1.

| package | repository | used for |
|---|---|---|
| `@seneca/cloudflare-d1-store` | [SenecaCloudflareD1Store](https://github.com/senecajs/SenecaCloudflareD1Store) | **storage on both servers** |
| `@seneca/gateway-cloudflare` | [SenecaCloudflareGateway](https://github.com/senecajs/SenecaCloudflareGateway) | **the admin endpoint on Workers** (4.5) |
| `@seneca/cloudflare-do-store` | [SenecaCloudflareDOStore](https://github.com/senecajs/SenecaCloudflareDOStore) | not in v1. A Durable Object has its own storage, so this is the escalation path if full per-account copies outgrow one D1 database (3.5) |
| `@seneca/cloudflare-r2-store` | [SenecaCloudflareR2Store](https://github.com/senecajs/SenecaCloudflareR2Store) | not in v1. A candidate for publishing the CSV and JSON dataset for download through the portal |
| `@seneca/cloudflare-kv-store` | [SenecaCloudflareKVStore](https://github.com/senecajs/SenecaCloudflareKVStore) | not in v1. KV is eventually consistent, so it is unsuited to keys that must revoke promptly |

**Their state, as found.**

- **Versions.** All five are at 0.0.1, and **none is on npm**.
- **Tests.** All five are tested with jest and Miniflare.
  - The D1 store's 15 tests pass. Its peer range `seneca >=3` resolves to
    Seneca 3.38; with `4.0.0-rc5` swapped in, all 15 still pass.
  - The gateway's 9 tests pass, on Seneca `4.0.0-rc4`.
- **Unused test suite.** The D1 store lists `seneca-store-test` but does not
  run it.
- **An open question answered.** The gateway's README leaves open whether
  Seneca's plugin loading works inside a Worker. Spike 0.1 answers it: it
  does, when plugins are passed as objects (Appendix A).

**The D1 store's design, which the plan adopts (3.5).**

- One table per canon, `(id TEXT PRIMARY KEY, data TEXT)`, holding each record
  as JSON, and created on first use.
- `list$` filtering through `json_extract`, with `sort$`, `limit$`, `skip$`
  and `fields$`.
- A partial update merges into the stored record.
- Two clients behind a two-method `query`/`run` interface: the Workers
  binding, and Cloudflare's REST API for use from Node.

**The work needed in each.**

- **The D1 store:**
  - A **`node:sqlite` client** behind the same `query`/`run` interface, so
    the Fastify server uses this store on a local file. That needs SQLite's
    JSON functions, which `node:sqlite` includes.
  - Run `seneca-store-test` on all three clients: binding (through Miniflare),
    `node:sqlite`, and REST (mocked).
  - Make the default page size of 11 explicit in its README, or remove it. The
    generated plugin passes `limit$` either way.
  - Make sure tables that migrations create first, with their own indexes,
    are left alone, which `CREATE TABLE IF NOT EXISTS` already does.
  - Publish.
- **The gateway:**
  - Publish it, along with any `@seneca/gateway` changes it needs.
  - Document mounting it behind a caller-supplied token check (4.5), and
    overriding its default CORS headers.
- **The other three:** nothing for v1.

`senecajs/seneca-sqlite-store` is no longer needed for v1 (D18 supersedes
D12).

---

## 9. Packages and repositories

| what | where |
|---|---|
| The four targets | this repository, `@voxgig/sdkgen-portalpack` |
| Storage, on both servers | `senecajs/SenecaCloudflareD1Store`, published as `@seneca/cloudflare-d1-store` |
| The admin endpoint | `@seneca/gateway` (published) and `senecajs/SenecaCloudflareGateway`, published as `@seneca/gateway-cloudflare` |
| The developer and agent portal | `voxgig/portal` (separate, later) |
| Everything else | generated, for one API, into the SDK repository |

The generated packages are linked by sibling `file:` paths (§6). The servers
are applications, not published libraries.

This pack's own dependencies:

- **Peers:** `@voxgig/sdkgen` and `@voxgig/apidef`, as infrapack declares them.
- **Generation time:** `aontu` (through sdkgen), and `ajv` with `ajv-formats`
  (§7).

The versions used by generated packages are pinned in each target model's
`deps` block, and collected with `collectDeps` as seneca-provider does.

---

## 10. Model options

These are set in `.sdk/model/project.aontu`. The names are provisional and will
be fixed in Phase 1.

| target | option | default | meaning |
|---|---|---|---|
| `devapi-data` | `seed` | the API slug | PRNG seed |
| | `entity.<e>.count` | `20` (`{per, min, max}` for children) | |
| | `entity.<e>.field.<f>.gen` | derived (3.1) | |
| | `entity.<e>.fixed.<key>` | `{}` | literal records |
| | `paging` | none | `{ limit, offset }` or `{ page, size }` parameter names, globally or per entity |
| | `put` | `merge` | `replace` makes update replace the record |
| | `limits.accounts`, `limits.records` | unset, `10000` | how many accounts may be initialised; rows per account per entity |
| `devapi-access` | `key.prefix` | the API slug | |
| | `cache.ttl` | `30` | seconds |
| | `admin.path` | `/devapi-admin` | the admin endpoint (4.5); absent without `DEVAPI_ADMIN_TOKEN` |
| `devapi-fastify` | `port` | `8901` | |
| | `db.file` | `.devapi/devapi.sqlite` | |
| `devapi-cloudflare` | `worker.name` | `<slug>-devapi` | |
| | `d1.database_name`, `d1.database_id` | `<slug>-devapi`, unset | `deploy` refuses while the id is unset |
| all | `output.path` | in-tree `<target>/` | as for seneca-provider |

---

## 11. This repository

```
.sdk/model/target/devapi-{data,access,fastify,cloudflare}.aontu
.sdk/src/cmp/devapi-*/Main_devapi-*.ts      # one Main per target
.sdk/src/cmp/devapi-*/Shared_devapi.ts      # identical copies, checked by a test (§2)
.sdk/tm/devapi-*/                           # static files
sdkgen-package.json                         # provides.target: the four; parity: CONSUMER x4
package.json  tsconfig.json  Makefile
tools/comment-gate.cjs  tools/dep-gate.cjs  # copied from infrapack, with their tests
.githooks/pre-push
.github/workflows/{build,comments,publish,servers}.yml
release/README.md
test/*.test.js                              # @voxgig/sdkgen/testkit suites
docs/design/devapi.md                       # this file
spike/seneca-workers/                       # Appendix A; deleted when Phase 1 lands
AGENTS.md (CLAUDE.md -> AGENTS.md)  COMMENT-POLICY.md  COMMENT-NOTES.md  README.md
```

Releases follow the sibling packs: an OIDC-dispatched `publish.yml`, and never
a local publish.

---

## 12. Testing

| layer | where | what |
|---|---|---|
| Store | `SenecaCloudflareD1Store` | `seneca-store-test` on the binding (Miniflare), `node:sqlite` and REST clients; the `INSERT … SELECT` init copy; the expression indexes being used |
| Admin endpoint | servers | Only the allow-listed patterns pass; a missing or wrong token answers 401; with no token configured the endpoint is absent; no CORS headers |
| Generation | here, on `@voxgig/sdkgen/testkit` | Each target on a solardemo-shaped fixture: planet, with moon nested under it, the `terraform` and `forbid` actions, and a create answering 201. Checks: the files emitted; no placeholder leaks; the "requires `devapi-data` and `devapi-access`" error; the unsupported-auth error; a cycle in `per`; a route path collision falling back to the catch-all; the CSV matching a golden copy, byte for byte; the copies of `Shared_devapi.ts` being identical. |
| Generated plugins | in each generated package's suite, run here in `servers.yml` | `sys:devapi-data` on the mem store and the D1 store's `node:sqlite` client: init, reset, the operation table (3.6), and request and response transforms against the case table shared with `TestFeature.ts`. `sys:devapi-access`: generate, verify, revoke, rotate, and expiry honoured on a cache hit. |
| Servers | here, in `servers.yml` (like langpack's `sdks.yml`) | Generate both servers, install and build them. Run Fastify under Node and the Cloudflare server under `wrangler dev`. Run one request script against each. |
| **Parity** | here, in `servers.yml` | The same script against both servers gives identical responses once ids and timestamps are normalised, including the validation failures. |
| SDK round trip | here, in `servers.yml` | Where `ts` is generated, its live suite runs against both servers with a devapi-access key. |
| Isolation | servers | Account A's writes are invisible to B. A reset restores the seed. An account that is not initialised answers 403. A revoked key answers 401 within the cache TTL. |

As in infrapack, there are `current` and `floor` dependency lanes, and a daily
schedule.

---

## 13. Risks

| risk | mitigation |
|---|---|
| ~~Seneca on workerd~~ | **Retired by spike 0.1** (Appendix A). |
| Seneca 4 is a release candidate | Pin it exactly. The spike ran on `4.0.0-rc5`. |
| The Seneca Cloudflare packages are 0.0.1 and unpublished | Phase 2 runs `seneca-store-test` on the D1 store and publishes it and the gateway before any target depends on them. |
| `json_extract` queries scan the table | Expression indexes on `account_id`, created by the generated migrations (3.5). |
| Full-copy storage growth | `limits.accounts`, the arithmetic stated in the README, and the copy staying on the database side (3.5). |
| Fidelity of the JSON Schemas | apidef's resolved schemas can be cyclic. Bound them with `boundedFacts`, and test the ajv-standalone output against the same fixtures as Fastify. |
| Response-shape fidelity | The case table shared with `TestFeature.ts`, and the SDK round trip in CI. |
| apidef merges request and response fields | Use `ro` where the spec sets it, and make read-only overridable per field. |
| Route shapes v1 does not serve | GraphQL, raw bodies and collection actions answer 501 and are listed in the README. |
| `file:` siblings and out-of-tree output | Paths are computed from the actual output locations, and generation warns when a server leaves the SDK repo. |
| Emitting `custom.ts` only once | Check jostraca's support in Phase 1. If it has none, the generator never writes the file and the README shows how to add it. |

---

## 14. Order of work

0. **Spikes.**
   1. **Done:** Seneca on workerd with D1 (Appendix A).
   2. The spec's JSON Schemas for solardemo and two real specs through
      `pointFacts` and ajv-standalone, checking cycles, formats and size.
   3. aontu: unify a derived base with project overrides, and check the
      conflicts are located.
1. **Pack scaffold.** Manifests, gates, CI, the agent guide, the target
   models, and `Shared_devapi.ts`. *Exit:* `npm test` and `package check` are
   green.
2. **The Seneca Cloudflare packages.** Add the D1 store's `node:sqlite`
   client, and publish the store and the gateway. *Exit:* `seneca-store-test`
   is green on all three of the D1 store's clients, and both packages are on
   npm.
3. **`devapi-data`.** *Exit:* solardemo's CSV and JSON are byte-identical
   across runs; the plugin's operation table and init and reset pass on the
   `node:sqlite` client.
4. **`devapi-access`.** *Exit:* the key lifecycle passes on mem, `node:sqlite`
   and D1.
5. **`devapi-fastify`.** *Exit:* the generated TypeScript SDK's live suite
   passes against it, and so do the isolation tests.
6. **`devapi-cloudflare`.** *Exit:* the same suite passes under
   `wrangler dev`, the parity test is green, and `wrangler deploy --dry-run`
   succeeds.
7. **Release 0.1.0** of this pack.

Phases 2 and 3 can run in parallel once Phase 1 lands.

---

## 15. Decisions

These were made in review. D17 and D18 came after the Seneca Cloudflare
packages were pointed out, and D18 supersedes D12.

| # | question | ruling |
|---|---|---|
| D1 | sdkgen kind | four targets, `parity: CONSUMER` |
| D2 | Runtime code | none shared. The business logic is generated per API: `devapi-data` generates `sys:devapi-data`, and `devapi-access` generates `sys:devapi-access`. |
| D3 | Per-account storage | a full **copy of the seed per account** |
| D3a | When the copy is made | an **explicit init call**; until then requests answer 403 `account_not_initialised` |
| D4 | What an account is | an **opaque id with a status**, supplied by the caller, with keys issued under it; devapi-access is about keys, not users |
| D5 | Key hashing | HMAC-SHA-256 with a server pepper |
| D6 | Getting keys | `voxgig/portal` will provide the developer and agent portal (see D17) |
| D7 | When data is generated | at sdkgen generation time, committed |
| D8 | Request validation | the **OpenAPI JSON Schemas** |
| D9 | Cloudflare routing | **one generated file per route**, with a catch-all only for collisions |
| D10 | Seneca | the 4.0.0 RC line |
| D11 | Linking server packages | sibling `file:` dependencies |
| D12 | D1 support | ~~a D1 driver in `seneca-sqlite-store`~~, superseded by D18 |
| D13 | Scopes | none in v1 |
| D14 | Paging | explicit model configuration |
| D15 | Serving the definition | yes, copied in |
| D16 | Target name | `devapi-cloudflare` |
| D17 | How the portal reaches a deployed server | an **admin endpoint** on both servers: `@seneca/gateway`, through `@seneca/gateway-cloudflare` on Workers, allow-listed and guarded by a service token (4.5) |
| D18 | Storage | **`@seneca/cloudflare-d1-store` on both servers**: the D1 binding on Workers, and a new `node:sqlite` client on Node |

---

## 16. Open questions, non-goals and later work

### Open questions

- **Q1. How the portal reaches a server.** Resolved as D17: the admin
  endpoint (4.5).
- **Q2. Removing an account.** Should `devapi-access` `remove:account` also
  trigger `sys:devapi-data,remove:account`, or should the caller always make
  both calls, as v1 does?

### Not in v1

- GraphQL points, raw bodies and webhooks;
- HTTP Basic and OAuth token exchanges, which are refused at generation;
- key scopes, rate limits and usage metering;
- per-API error bodies;
- collection-action defaults;
- self-service signup on the mock servers. That belongs to the portal.

### Later

1. `voxgig/portal` built on the admin endpoint (D17).
2. `seedFor('sdk-test')` wired into the TypeScript SDK's `test` feature.
3. Collection-action defaults built from the response schemas.
4. A generated deploy workflow for `devapi-cloudflare`.

---

## Appendix A: spike 0.1, Seneca on workerd

**Question:** can Seneca 4 and seneca-entity run inside an Astro Worker against
D1, well enough to carry the design in §2? **Answer: yes.** The code is in
[`spike/seneca-workers/`](../../spike/seneca-workers/), with steps to rerun it.

**What was built.**

- A prototype D1 store for seneca-entity, about 90 lines, with equality
  queries. It was written before `@seneca/cloudflare-d1-store` came to light,
  and now stands in for that store. The real store keeps each record as a JSON
  `data` column, where the prototype used one column per field. Its 15 tests
  also pass on Seneca 4.0.0-rc5 (§8), so the result carries over.
- A prototype `sys:devapi-data` plugin with explicit per-account init and CRUD
  scoped to one account.
- Generated-style Astro endpoint files for `/planet` and `/planet/[id]`.
- Versions: `seneca@4.0.0-rc5`, `seneca-entity@28.1.0`,
  `seneca-promisify@3.7.2`, `astro@7.3.8`, `@astrojs/cloudflare@14.3.4` and
  `wrangler@4.151.0`, with the `nodejs_compat` flag.

**What was run.** The built Worker ran under `wrangler dev` (workerd) with a
local D1, and the same project ran under `astro dev`. All of this behaved as
designed:

- a request before init answered 403 `account_not_initialised`;
- init copied the seed for an account;
- list, create (201), patch, remove, and load of a removed record (404) all
  worked;
- a second account was unaffected by the first account's changes;
- `reset: true` restored the seed.

**Measured on local workerd.** These numbers indicate scale; they are not
production figures.

| | |
|---|---|
| Worker upload | 1,394 KiB total, **352 KiB gzipped**, against the 3 MB free-plan limit |
| Seneca's chunk | 706 KiB, before compression |
| First request on a fresh process | about 284 ms (Seneca start-up plus a D1 read) |
| Warm requests | about 15 ms |
| Init (3 records, saved one at a time) | about 30 ms |

**What the generated code must do, as learned.**

1. **Pass plugins as objects** (`.use(SenecaEntity, …)`). Seneca resolves a
   plugin name with a runtime `require`, which a bundled Worker cannot do.
2. **Give seneca-entity `mem_store: false`.** Otherwise it loads
   seneca-mem-store as well.
3. **Read bindings from `cloudflare:workers` and start Seneca lazily**, once
   per isolate, because Workers allow no I/O outside a request.
4. **Turn off the adapter's default `SESSION` (KV) and `IMAGES` bindings.**
   The build adds them to the generated `wrangler.json` without being asked.
5. **Expect `astro dev` to start as a daemon** in Astro 7, stopped with
   `astro dev stop`.
6. **Do the seed copy in batches.** Saving records one at a time was fine for
   3 records, but would not be for thousands. This is why §3.5 copies with
   `INSERT … SELECT` through the store's native handle.

No warnings appeared in the Worker log, and no `eval` or `new Function` was
hit.
