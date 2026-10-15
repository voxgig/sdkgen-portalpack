# devapi: mock developer APIs generated from the SDK model

**Status: plan for review.** Nothing here is built yet. Points that need a
ruling are collected in [Decisions for review](#15-decisions-for-review), each
with a recommendation. Everything else is the shape this plan recommends.

This pack, `@voxgig/sdkgen-portalpack`, adds four targets to the
[Voxgig SDK Generator](https://github.com/voxgig/sdkgen). Together they turn the
API model an SDK is generated from into a working **mock of that API**, with:

- realistic, repeatable data;
- per-developer API keys and accounts;
- a server that answers the same routes the SDK calls, run locally on Fastify
  or deployed to Cloudflare Workers.

| target | produces | runs on |
|---|---|---|
| `devapi-data` | A mock dataset for every entity, defined in aontu. It is delivered as pregenerated CSV (and JSON) and as a TypeScript package with a programmatic interface. | TypeScript only |
| `devapi-access` | API-key generation and validation, plus account management. It is a programmatic interface configured for this API's authentication scheme. | Seneca plugin; works with any store |
| `devapi-fastify` | A mock server for every model route, on Fastify. Each account's changes are stored in SQLite. | Node 24 |
| `devapi-cfw` | The same server on Cloudflare Workers, using Astro. Each account's changes are stored in D1. | workerd |

**The two servers share one business-logic layer, written as Seneca messages.**
Between them, only the HTTP adapter and the Seneca store plugin differ.

## Contents

1. [Why four targets, not features](#1-why-four-targets-not-features)
2. [Architecture](#2-architecture)
3. [devapi-data](#3-devapi-data)
4. [devapi-access](#4-devapi-access)
5. [The engine: per-account mock behaviour](#5-the-engine-per-account-mock-behaviour)
6. [devapi-fastify](#6-devapi-fastify)
7. [devapi-cfw](#7-devapi-cfw)
8. [A Seneca store for SQLite and D1](#8-a-seneca-store-for-sqlite-and-d1)
9. [Packages and repositories](#9-packages-and-repositories)
10. [Model options](#10-model-options)
11. [This repository](#11-this-repository)
12. [Testing](#12-testing)
13. [Risks and spikes](#13-risks-and-spikes)
14. [Order of work](#14-order-of-work)
15. [Decisions for review](#15-decisions-for-review)
16. [Non-goals for v1, and later](#16-non-goals-for-v1-and-later)

---

## 1. Why four targets, not features

An sdkgen package can provide three kinds of thing: `target`, `feature` and
`edition` (`ts/src/action/kind.ts` in sdkgen). The request calls these four
"features", but in sdkgen's vocabulary all four are **targets**.

- **A feature extends a generated SDK.** Its source is copied into a target's
  output, and it runs inside the SDK's operation pipeline through hooks
  (sdkgen's `cmp/Feature.ts` and `cmp/FeatureHook.ts`).
  - Neither devapi-data nor devapi-access is part of any SDK's pipeline. Each
    needs output of its own: CSV files, and a key-management interface.
  - A feature could be limited to the two server targets only through a new
    applicability tag, and the tag vocabulary is closed (`sekreto` and
    `schema`, in `ts/src/helpers/applicability.ts`).
- **An edition is a documentation build** rendered by `@voxgig/docgen`. That
  is not what this is, though a developer-portal edition is a natural later
  step for a pack with this name (§16).
- **A target fits all four.** They use the consumer-target shape that
  `seneca-provider` established in `sdkgen-infrapack`: every standard phase off,
  the whole package emitted from `Main`, and `parity: CONSUMER`.

**How the targets depend on each other.** No manifest field can say "this
target needs that one". sdkgen documents that gap as deliberate. So the
requirement lives where infrapack keeps its own: in the README, and in a throw
from `Main`.

- `devapi-fastify` and `devapi-cfw` fail at generation unless `devapi-data`
  and `devapi-access` are both in the model. The data definition and the
  access settings they serve live in those two targets' model options.
- Neither server needs the `ts` target. When `ts` is present, the server's
  generated suite also drives the generated TypeScript SDK against the running
  mock. That is the strongest available proof that the SDK and the mock agree.

---

## 2. Architecture

```
        generation time (sdkgen + this pack)                      run time
 OpenAPI ─apidef─▶ model (.sdk/model/*.aontu)
                     │
                     ├─ devapi-data    ─▶ devapi-data/     CSV, JSON, data package
                     ├─ devapi-access  ─▶ devapi-access/   access package, CLI
                     ├─ devapi-fastify ─▶ devapi-fastify/ ─┐
                     └─ devapi-cfw     ─▶ devapi-cfw/     ─┤
                                                           ▼
     ┌────────── HTTP adapter: Fastify route  |  Astro endpoint ───────────┐
     │  Seneca   sys:devapi (engine)        sys:devapi-access (keys)       │
     │  seneca-entity ─▶ store: sqlite (node:sqlite) | d1 | mem (tests)    │
     └─────────────────────────────────────────────────────────────────────┘
```

### Thin generated code, thick runtime

infrapack's `Extras_seneca-provider.ts` is 4,700 lines of TypeScript held in
template strings. That is hard to test, and a fix to any of it reaches users
only when they regenerate. This pack inverts the ratio:

- **Generated output** is data and wiring:
  - `devapi.json`, the API surface normalised from the model (below);
  - the seed dataset;
  - configuration (`package.json`, `wrangler.jsonc`, `astro.config.mjs`);
  - an entry point of a few dozen lines;
  - tests and a README.
- **Behaviour** lives in published runtime packages that are unit-tested
  outside generation (§9). A fix ships as a version bump.

### `devapi.json`: one derivation, used by every target

Every target derives the same file from the model, through one shared helper.
It contains:

- **Entities.**
  - Each entity's name.
  - Its record key. This uses the same rule as the TypeScript SDK's `test`
    feature (`ownIdField` in `TestFeature.ts`) and seneca-provider's
    `recordKey`.
  - Composite id parts, separator and `from` paths.
  - Fields: name, type sentinel, required, read-only, format, nullable.
  - Parents, from `relations.ancestors` and required path parameters.
- **Routes.** One for each active point, carrying:
  - the method, the wire path `o` and its segments `s`;
  - path, query and header arguments, and the `$action` name if any;
  - the request and response transforms `t`;
  - the success status and request schema, taken from apidef's resolved
    definition (`pointFacts`). This is never read from `def.paths` directly:
    sdkgen's ADR-001 forbids reading API shape from the raw definition.
- **Auth.** Taken from `isAuthActive`, `resolveAuthIn`, `resolveAuthName`,
  `resolveAuthPrefix` and `isHttpBasicAuth`. Through these, the mock expects a
  credential exactly where the generated SDK sends one.
  - v1 supports an API key in a header, query parameter or cookie, and a
    bearer token.
  - For HTTP Basic, or a scheme with a token exchange (`info.security.exchange`),
    generation fails with an explicit unsupported-auth error rather than emit
    a server its own SDK cannot call (§4.3).
- **Info.** The title, the version, and the base path taken from
  `info.servers[0].url`.

The runtime validates `devapi.json` against a schema it ships, and refuses to
start on a file it does not understand.

### The Seneca message surface

Seneca is the isolation layer. Business logic is written as message handlers,
and storage goes through `seneca-entity`, so the same handlers run on Node and
on workerd. What differs per environment is which store plugin is loaded.

| pattern | what it does |
|---|---|
| `sys:devapi,handle:request` | The one entry point used by both adapters. It takes `{method, path, query, headers, body}` and returns `{status, headers, body}`. |
| `sys:devapi,entity:<e>,op:<op>` | List, load, create, update, patch or remove for one account (§5). |
| `sys:devapi,entity:<e>,action:<a>` | A custom action route: an alternative point carrying `$action`. |
| `sys:devapi,reset:account` | Discards an account's changes, returning it to the seed. |
| `sys:devapi,get:info` | The API name, version, entity list and data seed. |
| `sys:devapi-access,…` | Accounts and keys (§4). |

Customising the mock means overriding a pattern with Seneca's `prior`. The
generated files are never edited (§5.5).

---

## 3. devapi-data

### 3.1 The data is defined in aontu; aontu does not generate it

aontu defines, unifies, constrains and validates structures. It deliberately
has **no randomness**: aontu.dev states that it has "no user-defined
functions, clock, or randomness". So the work divides cleanly:

- **aontu defines the dataset.** It holds the shape of every record, the
  per-field generation rules, the record counts and any fixed records. It
  merges the layers below, and reports every disagreement with its location.
- **A small seeded TypeScript expander generates the records.** It is part of
  `@voxgig/devapi/data`. It reads the *resolved* definition, which is plain
  JSON once aontu has evaluated it, so the expander never runs aontu. That
  matters on Workers, where it never has to.

The definition is three layers, unified rather than overridden:

1. **The derived base.** `devapi-data` emits it from the model:
   - field types, required flags and nullability;
   - OpenAPI enums and formats, and parameter examples (`ex`);
   - name heuristics: `email`, `url`, `*_at`, `name`, `title`, and `*_id`
     where an entity of that stem exists.

   Every value in the base is an aontu default (`*`), so a project can
   override any of them.
2. **The project's overrides.** These go in `.sdk/model/project.aontu` under
   `main: kit: target: 'devapi-data'`. That file is the same place infrapack
   tells projects to put target options, because `target add` overwrites the
   target's own model file.
3. **Fixed records.** These are literal records that must exist, such as the
   `earth` every demo needs.

```aontu
# .sdk/model/project.aontu: illustrative
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

Because the base carries an OpenAPI enum as a constraint
(`'rock' | 'gas' | 'ice'`), an override such as `pick: ['lava']` does not
silently produce invalid data. aontu reports a conflict and names both sites.

### 3.2 The generator vocabulary

| `gen` | value |
|---|---|
| `seq` / `id` / `uuid` | a sequential, short deterministic, or UUID-formatted identifier |
| `int: [min, max]`, `num: [min, max, dp]`, `bool: p` | numbers and booleans |
| `pick: [...]` (optional weights) | an enum member |
| `words: [a, b]`, `text: [a, b]` | lorem-style words or sentences, from built-in word lists |
| `name.first`, `name.last`, `name.full`, `email`, `url`, `phone` | person-shaped values. `email` derives from the record's own name fields. |
| `date: [from, to]`, `datetime: [from, to]` | ISO 8601 |
| `ref: <entity>` | the id of an existing record of that entity |
| `tmpl: '{name.first}.{name.last}@example.com'` | composed from the record's other fields |
| `const: v`, `null: p`, `omit: p` | a fixed value; nullable; optional and absent |
| `list: {count, of}`, `obj: {…}` | nested arrays and objects |

**The core has no dependency on faker**, to keep the Workers bundle small.
`gen: 'faker:person.jobTitle'` is an opt-in bridge used when `@faker-js/faker`
is installed. It is seeded from the same stream, so its output stays
deterministic.

### 3.3 Determinism and referential integrity

- **Each value is a pure function** of `(seed, entity, index, field)`, computed
  by a hash-seeded PRNG stream per cell. Adding a field or raising a count
  therefore does not reshuffle any value that already exists, so diffs of the
  generated CSV stay reviewable.
- **Keys first, then fields.** A record's key is itself a pure function of
  `(seed, entity, index)`. Every entity's keys are minted in a first pass, and
  fields are filled in a second.
  - `ref` therefore resolves for self-references (`employee.manager_id`) and
    for cycles (`a → b → a`), as well as for parents.
  - A `ref` that should sometimes be empty, such as a root manager, says so
    with `null: p`.
- **Child counts need an acyclic parent graph.** `count: { per: 'planet', … }`
  distributes child records across their parents, ordered by
  `relations.ancestors` and required path parameters.
  - A cycle in that graph is rejected at generation, with the cycle named.
  - A nested route such as `/planet/{planet_id}/moon` always has data.
- **Every record is validated** against the entity's data spec before it is
  written. The spec comes from sdkgen's `entityDataSpec`, the same
  `@voxgig/struct` spec the generated SDK validates with, so the dataset passes
  the SDK's own checks by construction.

### 3.4 Outputs

```
devapi-data/                       # in-tree by default; output.path moves it
  package.json                     # <sdk-package>-devapi-data
  model/data.aontu                 # the derived base, for reference
  data/spec.json                   # the resolved definition the expander read
  data/json/<entity>.json          # records, keyed by record key
  data/csv/<entity>.csv
  src/index.ts  src/types.ts       # typed programmatic interface (3.5)
  test/data.test.ts
  README.md
```

The CSV format follows RFC 4180, in UTF-8 with LF line endings:

- the header row is the field names in model order, with the record key first;
- `null` is written as an empty cell;
- an object or array is written as JSON text in one cell;
- dates are ISO 8601.

The README states these rules, so the files can be imported into a
spreadsheet or a database as they are.

### 3.5 The programmatic interface

```ts
import { data } from '@acme/solar-sdk-devapi-data'

data.entities()                       // ['moon', 'planet']
data.list('planet', { kind: 'rock' }) // Planet[], in seed order
data.load('planet', 'earth')          // Planet | undefined
data.csv('planet')                    // string
data.regenerate({ seed: 'x', count: { planet: 100 } })  // a new, independent dataset
data.seedFor('sdk-test')              // { entity: { planet: { earth: {...} } } }
```

`seedFor('sdk-test')` returns the seed shape the TypeScript SDK's `test`
feature reads. A generated SDK's offline suite can therefore run on realistic
data. Wiring that in is a later step (§16), but the interface allows it from
the start.

### 3.6 When the data is generated

The data is generated **at sdkgen generation time**, and the output is
committed with the rest of the generated tree (D7). That gives:

- the same seed always produces the same bytes;
- CSV exists as soon as `npm run generate` finishes;
- a change to the data definition shows up as a reviewable diff.

`regenerate()` covers anyone who needs a different seed or size at run time.
It uses the same expander, so it produces the same output for the same inputs.

---

## 4. devapi-access

API-key generation and validation, and account management. It is a Seneca
plugin, `sys:devapi-access`, and it stores everything through `seneca-entity`.
The same code therefore runs against `mem` in tests, SQLite under Fastify and
D1 on Workers. This is the case the request names for Seneca.

### 4.1 Entities

- **`devapi/account`** holds `id`, `handle` (unique), `email`, `name`,
  `status` (`active` or `suspended`), `created` and `limits`.
- **`devapi/apikey`** holds:
  - `id`, which is the key id (`kid`);
  - `account_id`, `name`, `hash` and `scopes`;
  - `status` (`active` or `revoked`), `created` and `expires`;
  - `last_used`, written at most once an hour per key so that it does not
    cost a D1 write per request.

Accounts are minimal on purpose (D4). `@seneca/user` brings passwords, logins
and verification tokens that a key-only, programmatic model does not use, and
each of those is more surface to make work on workerd. A portal that needs
logins later can bridge accounts onto `sys/user`.

### 4.2 Keys

- **Format:** `<prefix>_<kid>_<secret>`, for example `solar_k7m2q9x4h1tb_…`.
  - The `prefix` is the API slug, so a leaked key is recognisable in logs and
    by secret scanners.
  - The `kid` is 12 characters of Crockford base32, stored in clear and used
    for lookup.
  - The `secret` is 32 random bytes, base64url-encoded.
- **Storage:** only `HMAC-SHA-256(pepper, secret)` is stored. The pepper is a
  server secret: `DEVAPI_KEY_PEPPER` in `.env`, or a Wrangler secret. The
  plaintext key is returned once, when it is created.
- **Why a fast hash and not bcrypt or PBKDF2 (D5).** A key's secret holds 256
  random bits, so a slow hash adds no resistance to brute force. It would cost
  CPU on every request, and Workers meter CPU. This is the established
  practice for API keys. (`@seneca/apikey`, at 0.1.0, also uses a fast iterated
  SHA-512.)
- **Crypto API:** WebCrypto (`crypto.subtle`) on both platforms, which needs
  no `nodejs_compat`. Verification uses `crypto.subtle.verify('HMAC', …)`,
  which compares in constant time.

### 4.3 Verifying a request

1. Extract the credential from where the model's security scheme puts it.
   For example, `Authorization: Bearer <key>`, or an `x-api-key` header or
   query parameter, as resolved by sdkgen's auth helpers. The generated SDK's
   `apikey` option therefore works against the mock unchanged.
2. Parse it, load the key by `kid`, and check its status and expiry.
3. Verify the HMAC, then load the account and check its status.
4. Return `{ account_id, kid, scopes }`.

Schemes outside step 1's list are refused at generation (§2), so the server
never expects a credential its SDK cannot send.

A successful verification is cached per isolate for a short time (default 30 s,
in an LRU) to save store reads.

- **Expiry stays exact.** The cache entry keeps the key's `expires`, and checks
  it again on every hit.
- **Revocation does not.** Revocation and account suspension take effect
  within the cache time, and the README says so.

An API whose model declares no authentication gets a single implicit account.
The per-account machinery still runs; it just never varies.

### 4.4 Scopes

Scopes are derived from the model: `<entity>:read` covers list and load, and
`<entity>:write` covers create, update, patch, remove and actions. A key gets
`*` by default. Scope checks run in the engine before the operation, and a
failure answers 403.

### 4.5 The interface

| pattern | |
|---|---|
| `create:account`, `get:account`, `list:account`, `update:account`, `remove:account` | Removing an account revokes its keys and emits `sys:devapi,on:account-removed`, which drops its data changes. |
| `generate:key`, `list:key`, `revoke:key`, `rotate:key` | `generate` and `rotate` return the plaintext key once. `list` never returns a secret or a hash. |
| `verify:key` | Takes a raw credential and returns `{ ok, account_id, scopes }` or `{ ok: false, why }`. |

The generated `devapi-access/` package wraps these messages in a typed facade
(`access.createAccount(…)`, `access.generateKey(…)`, `access.verify(…)`) for
code that does not use Seneca. It also carries the shared SQL migrations and a
CLI.

### 4.6 Getting a key (D6)

| where | how |
|---|---|
| Fastify, local | Use the CLI, `npx devapi-access account create alice` and `npx devapi-access key create alice`, which works directly on the SQLite file. |
| Fastify, dev mode | The server gives a `dev` account a stable local key. It uses the key in `<ENV>_APIKEY` if that is set and well formed. Otherwise it creates one on first start, writes it to the gitignored `.devapi/dev.env` as `<ENV>_APIKEY=…`, and reuses it on later starts. The generated `test:sdk` script and the live-suite instructions load that file, so the SDK's live suite gets the key without anyone copying it from stdout. In CI, where the two processes start separately, the job sets `<ENV>_APIKEY` to any well-formed key (`npm run dev-key` prints one) and the server registers it. |
| Workers | Admin routes under `/_devapi/admin/` are authenticated with `Bearer $DEVAPI_ADMIN_TOKEN` (a Wrangler secret) and are disabled when it is unset. The same CLI drives them with `--remote <url>`. |
| Both | The admin routes also exist under Fastify, so the two servers expose the same surface. |

Self-service signup is out of scope for v1. It is the first thing a portal
would add (§16).

`/_devapi/` is reserved. Generation throws if a model route collides with it.

---

## 5. The engine: per-account mock behaviour

The engine is `@voxgig/devapi/engine`: a Seneca plugin serving `devapi.json`
over the seed dataset. Both servers load it unchanged.

### 5.1 The seed is shared; changes are per account (D3)

The seed is immutable and shared by every account. Each account's writes go to
a **copy-on-write overlay**, a single table `devapi_rec`:

```
devapi_rec(account_id, entity, rkey, state, data, updated)
  state: 'put' | 'del'        unique (account_id, entity, rkey)
```

What a request sees is the seed, plus the account's `put` rows, minus its
`del` rows.

- **Account creation costs nothing.** No seed is copied, which matters with
  D1's write pricing.
- **Every account's view stays separate**, and a reset is one `DELETE`.
- **A regenerated seed reaches every account** on the next deploy, except
  where that account has changed a record.

The `account_id` always comes from the verified key, and never from the
request.

The rejected alternatives:

- **Copying the whole seed per account** is simpler to read, but costs N
  writes per account and freezes old data.
- **A database per account** (a SQLite file each, or a Durable Object each on
  Cloudflare) isolates more strongly, at much higher operational cost. A
  Durable Object per account remains the escalation path if a deployment ever
  needs it (§16).

### 5.2 How each operation behaves

| op | behaviour |
|---|---|
| list | The merged view, filtered by the route's parent path parameters and by any query parameter that names a record field. Other required parameters, such as `q` or `locale`, are checked for presence but never filter, because no seed record carries them. (The SDK `test` feature filters on every required parameter; the mock deliberately does not.) Seed order first, then creation order. Paging applies only where `serve.paging` names the parameters (open question Q2). |
| load | The account's `put` row if there is one; 404 if it has a `del`; otherwise the seed record; otherwise 404. |
| create | The record key is minted unless the create sends it, the case seneca-provider calls `rkOnCreate`. A key that already exists answers 409. Read-only fields the request did not send, such as `created_at`, are filled by the entity's generator rules, so a created record looks like a seeded one. The status is the spec's success code: 201 where the spec says 201. |
| update / patch | 404 if the record is absent. Otherwise the body is merged into the record, keeping the key, the parents and read-only fields. Merging on update matches the SDK `test` feature. `serve.put: replace` switches update to PUT-as-replace. |
| remove | 404 if the record is absent. Otherwise a `del` row is written. The status is the spec's (200 or 204). |
| action on a record | Applies when the route addresses a record key. Loads the record (404 if absent), merges the body and returns the record. This is a generic default, and the expected place to customise (5.5). |
| action on a collection | Applies when there is no record key: an import, a search or a bulk operation. With no record to default to, the route answers 501 and the generated README lists it, until a Seneca override implements it (5.5). A default built from the spec's response schema is later work (§16). |

**Responses are wrapped the way the route's response transform `t.res`
unwraps them**: `body.data` is nested, and `$EACH` with `$MERGE` wraps each
list item under its key. The TypeScript SDK's `test` feature already does this
(`envelope` and `itemEnvelopeKey` in
`ts/project/.sdk/tm/ts/src/feature/test/TestFeature.ts`). The engine
implements the same rule, and a shared case table tests the two against each
other.

### 5.3 Validation (D8)

**Request bodies are decoded first.** A route's request transform `t.req` is
how the SDK turns its logical record into the wire body, and it can nest or
rename fields. The engine applies the inverse to an incoming body before it
validates or stores anything.

- Validation therefore sees the shape `entityOpSpec` describes, and the
  overlay stores records, not envelopes.
- The inverse is derived at generation time. A transform that cannot be
  inverted is reported at generation, and its route answers 501.
- Request transforms join response transforms in the shared case table, and
  the round-trip suite covers both directions.

The decoded body is then validated against the model-level specs sdkgen already builds for
the SDK (`entityOpSpec`, `canonToSpec`), using `@voxgig/struct`'s interpreting
validator.

- **It matches the SDK**: whatever the SDK accepts, the mock accepts.
- **It runs on Workers.** ajv compiles validators with `new Function`, which
  workerd forbids. So Fastify's own ajv validation is not used either, and the
  two servers keep identical behaviour.

Validation against the spec's own JSON Schema is a later option: `pointFacts`
already provides the schema, and precompiled ajv-standalone validators run on
both platforms.

The default is lenient: unknown fields are kept. `serve.strict: true` refuses
them.

### 5.4 Errors

Every error answers `{ statusCode, error, message }`:

| status | when |
|---|---|
| 400 | validation failed |
| 401 | the credential is missing or invalid; the `WWW-Authenticate` header follows the scheme |
| 403 | a scope or an account limit refused the request |
| 404 | the route or the record does not exist |
| 409 | the record key already exists |
| 413 | the account's overlay limit was reached |
| 501 | the route is GraphQL or has a raw body, neither of which v1 serves |

Matching each API's own error schema is a later step.

### 5.5 Customising behaviour with Seneca

Each generated server emits `src/custom.ts` once, and never overwrites it. The
entry point loads it after the engine:

```ts
export function custom(seneca: any) {
  seneca.message('sys:devapi,entity:planet,action:terraform', async function (msg: any) {
    const out = await this.prior(msg)
    out.record.kind = 'rock'
    return out
  })
}
```

The same file works under Fastify and on Workers, which is the isolation
working as intended. Whether jostraca can emit a file only when it is absent
has to be checked in Phase 1. If it cannot, the generator never writes
`custom.ts`, and the README shows how to add it.

### 5.6 Limits

Each account has a maximum number of overlay rows (`serve.limits.records`,
default 10,000) and a maximum body size. A public Workers deployment needs
both. Request-rate limits are deferred (§16).

---

## 6. devapi-fastify

```
devapi-fastify/                    # in-tree by default; see note on app/
  package.json                     # fastify 5, seneca, seneca-entity, seneca-promisify,
                                   # @seneca/sqlite-store, @voxgig/devapi
  devapi.json  data/seed.json      # derived (§2) and generated (§3)
  migrations/0001_devapi.sql       # identical file in devapi-cfw
  src/server.ts                    # build + listen, about 40 lines
  src/seneca.ts                    # plugin wiring: store, access, engine, custom
  src/custom.ts                    # user-owned (5.5)
  test/server.test.ts              # node:test with fastify.inject
  test/sdk.test.ts                 # only when the ts target exists: the SDK against the mock
  README.md  .gitignore  tsconfig.json
```

- **Routes.** `@voxgig/devapi/fastify` registers one native Fastify route for
  each entry in `devapi.json`, converting `{id}` to `:id`, under the base path
  from the spec's first server. `fastify.printRoutes()` therefore lists the
  real API. Every handler calls `sys:devapi,handle:request`.
- **Storage.** SQLite through `node:sqlite`, which needs no native build, in
  `.devapi/devapi.sqlite` (gitignored). Migrations are applied idempotently at
  startup. `npm run db:reset` deletes the file.
- **Scripts.** `dev`, `build`, `start`, `test`, `devapi-access` (the CLI) and
  `db:reset`. The default port is 8901, matching the sdkgen solardemo app; the
  model can change it.
- **As the companion live server.** sdkgen's `main.kit.test.live.app` and
  seneca-provider's live tests expect a server in the SDK repo's `app/`, and
  until now that server was hand-written (`ts/test/solardemo/app`). A project
  can set `main: kit: target: 'devapi-fastify': output: path: 'app'` and get a
  generated one. The dev key from 4.6 reaches the live suites through
  `.devapi/dev.env` locally, or through `<ENV>_APIKEY` in CI.

---

## 7. devapi-cfw

```
devapi-cfw/
  package.json                     # astro, @astrojs/cloudflare, wrangler, seneca…, @voxgig/devapi
  astro.config.mjs                 # output: 'server', adapter: cloudflare()
  wrangler.jsonc                   # nodejs_compat; d1_databases: DEVAPI_DB; migrations_dir
  devapi.json  src/data/seed.json  # bundled into the Worker
  migrations/0001_devapi.sql       # identical to devapi-fastify's
  src/pages/[...path].ts           # export const ALL = devapiHandler
  src/lib/seneca.ts                # lazy, once-per-isolate Seneca with the D1 store
  src/custom.ts                    # user-owned (5.5)
  test/worker.test.ts              # node:test driving the built Worker with Miniflare
  README.md
```

- **Routing (D9).** A single catch-all Astro endpoint hands the `Request` to
  `@voxgig/devapi/astro`, which matches against the same route table the
  Fastify adapter uses.
  - The two servers therefore route identically, which a parity test checks
    (§12).
  - Astro file-per-route is the alternative. It cannot express two paths that
    differ only in a parameter's name at the same position, which real specs
    contain.
- **Bindings.** These are read with `import { env } from 'cloudflare:workers'`,
  the Astro 6+ way. Workers forbid I/O outside a request, so Seneca and the
  store start lazily on the first request and are reused for the isolate's
  lifetime. Account context travels in each message and is never stored on
  the instance.
- **The seed** is bundled as a JSON module. Generation warns when the seed
  passes 1 MB, because Workers limit script size (3 MB compressed on the free
  plan). Seeding a shared D1 table is the later path for larger datasets (§16).
- **Local development.** `npm run dev` runs `astro dev` on workerd with a local
  D1. `npm run db:migrate:local` runs
  `wrangler d1 migrations apply DEVAPI_DB --local`.
- **Deployment.**
  1. Create the database with `wrangler d1 create`, and put its id in the
     model (`devapi-cfw: d1: database_id`). Generation overwrites
     `wrangler.jsonc`, so the id cannot live there.
  2. Set `DEVAPI_KEY_PEPPER` and `DEVAPI_ADMIN_TOKEN` with
     `wrangler secret put`.
  3. Run `npm run deploy`. It runs `astro build` first, so a failed build
     touches nothing, then the remote migrations, then `wrangler deploy`.
     The old Worker can still be serving while the new schema is in place, so
     migrations are additive only: expand now, contract in a later release.
     The runtime checks its schema version at startup.

  A generated GitHub deploy workflow is deferred (§16).
- **Tests** run inside workerd rather than Node: Miniflare runs the built
  Worker against a local D1, driven from `node:test`, so the runner is the same
  as everywhere else.

**The landing page** gives the API name and version and says how to
authenticate. The dispatcher serves it at `/_devapi/`, on both servers.

- **It is not an Astro page.** A static `src/pages/index.astro` would take
  priority over the catch-all and shadow a root API route. Astro also excludes
  `_`-prefixed paths from file routing.
- **`/` redirects to it** only when the model has no root route.
- **A developer portal** (§16) would add Astro pages under a configurable
  prefix, checked against the model's routes in the same way. Astro is already
  the framework, and the deployment already exists.

---

## 8. A Seneca store for SQLite and D1

No published Seneca store targets SQLite or D1. The npm registry has
`seneca-mem-store`, `seneca-postgres-store`, `@seneca/dynamo-store` and others,
but none for either. One package, `@seneca/sqlite-store`, covers both, because
D1 *is* SQLite:

- **Two drivers share one SQL builder.**
  - `driver: 'node'` uses `node:sqlite` `DatabaseSync`, wrapped as async, with
    `better-sqlite3` available as a fallback.
  - `driver: 'd1'` takes a `D1Database` binding and uses `batch()` where a
    call needs several statements.
- **Entity mapping.**
  - The canon `base/name` maps to the table `base_name`.
  - Columns come from `PRAGMA table_info`, read lazily on first use.
  - Object and array values are stored as JSON text.
  - `id` is a `TEXT` primary key.
- **Queries.** The query surface seneca-entity uses: equality matches, `$in`,
  `sort$`, `limit$`, `skip$` and `fields$`.
- **Tests.** `seneca-store-test`, the standard Seneca store suite, runs on both
  drivers, with D1 run through Miniflare.
- **Schema.** Explicit SQL migrations, shared by both servers: tables
  `devapi_rec`, `devapi_account` and `devapi_apikey`, with their indexes. The
  store does not create tables itself.

It is general-purpose Seneca infrastructure, so it belongs in the `senecajs`
organisation and not in this pack (D2).

---

## 9. Packages and repositories

**This repository holds generation, and nothing that runs in a generated
server.**

| package | repository | holds |
|---|---|---|
| `@voxgig/sdkgen-portalpack` | this repository | The four targets, their model files, components and templates, and the shared `devapi.json` derivation. |
| `@voxgig/devapi` | new: `voxgig/devapi` | The runtime, one package with subpath exports: `./data` (expander, CSV, interface), `./access` (plugin), `./engine` (plugin), `./fastify`, `./astro` (adapters), `./cli`. |
| `@seneca/sqlite-store` | new: `senecajs/seneca-sqlite-store` | §8 |

- **One runtime package, not five.** sdkgen's own pack notes count repositories
  as a real cost (`docs/design/pack-repositories.md`). Data, access and engine
  are released together and versioned together anyway, and subpath exports
  keep a Workers bundle to what it imports.
- **Why runtime packages rather than vendoring through `tm/` (D2).**
  - The runtime is roughly the same code for every API, so a fix reaches every
    generated server through a version bump, without regenerating.
  - It is unit-tested where it lives.
  - This pack's dependency gate forbids `workspace:` and `file:` links, so a
    monorepo here would fight the gate.
  - Vendoring stays a fallback, if publishing the runtime is blocked.
- **The pack also uses the runtime at generation time.** `devapi-data`'s `Main`
  runs the expander so that it can write CSV, so `@voxgig/devapi` is a
  dependency of this pack, beside the peer dependencies on `@voxgig/sdkgen` and
  `@voxgig/apidef` that infrapack declares. The generated packages depend on
  `@voxgig/devapi` and `@seneca/sqlite-store` by version range. Each target
  model's `deps` block pins those ranges, collected with `collectDeps` as
  seneca-provider's are.
- **The servers are self-contained.** They embed their own `devapi.json` and
  seed, and do not depend on the generated `devapi-data/` or `devapi-access/`
  folders. A server can therefore be generated out of tree, into its own
  repository, with no sibling path to resolve.

---

## 10. Model options

These are set in `.sdk/model/project.aontu`. Names are provisional and will be
fixed in Phase 1.

| target | option | default | meaning |
|---|---|---|---|
| `devapi-data` | `seed` | the API slug | the PRNG seed |
| | `entity.<e>.count` | `20` (`{per, min, max}` for children) | record count |
| | `entity.<e>.field.<f>.gen` | derived (3.1) | the generator rule |
| | `entity.<e>.fixed.<key>` | `{}` | literal records |
| | `csv`, `json` | `true` | which outputs are emitted |
| | `serve.paging`, `serve.strict`, `serve.put`, `serve.limits` | none, `false`, `merge`, as in 5.6 | engine behaviour, shared by both servers |
| `devapi-access` | `key.prefix` | the API slug | the key prefix |
| | `scopes` | `entity` | `none` or `entity` |
| | `admin` | `true` | whether the `/_devapi/admin/` routes exist |
| | `cache.ttl` | `30` | seconds a successful verification is cached |
| `devapi-fastify` | `port` | `8901` | |
| | `db.file` | `.devapi/devapi.sqlite` | |
| `devapi-cfw` | `worker.name` | `<slug>-devapi` | |
| | `d1.database_name`, `d1.database_id` | `<slug>-devapi`, unset | `deploy` refuses while the id is unset |
| all | `output.path` | in-tree `<target>/` | as for seneca-provider |

---

## 11. This repository

The layout mirrors `sdkgen-infrapack`, and its gates are adopted unchanged:

```
.sdk/model/target/devapi-{data,access,fastify,cfw}.aontu
.sdk/src/cmp/devapi-*/Main_devapi-*.ts        # one Main per target, plus small helpers
.sdk/tm/devapi-*/                             # static files: LICENSE, tsconfig, astro.config…
sdkgen-package.json                           # provides.target: the four; parity: CONSUMER ×4
package.json  tsconfig.json  Makefile
tools/comment-gate.cjs  tools/dep-gate.cjs    # copied from infrapack, with their tests
.githooks/pre-push
.github/workflows/{build,comments,publish,servers}.yml
release/README.md
test/*.test.js                                # @voxgig/sdkgen/testkit suites
docs/design/devapi.md                         # this file
AGENTS.md (CLAUDE.md → AGENTS.md)  COMMENT-POLICY.md  COMMENT-NOTES.md  README.md
```

- **The shared derivation of `devapi.json`.** Each target's components are
  copied into the consumer separately, and targets can be aliased, so a
  relative import between two targets' folders is fragile. The derivation
  therefore lives in `@voxgig/devapi/spec`, and every target's `Main` imports
  it from there. That gives one definition, tested once.
- **Releases** follow the siblings: an OIDC-dispatched `publish.yml` and never
  a local publish, except npm's unavoidable first version, as
  `release/README.md` records.

---

## 12. Testing

| layer | where | what |
|---|---|---|
| Runtime units | `voxgig/devapi` | The expander: determinism, integrity including self-references, and a golden CSV. Keys: generate, verify and revoke, with timing-safe comparison, and expiry honoured on a cache hit. Overlay semantics per operation. Request and response transforms, checked against a case table shared with `TestFeature.ts`. |
| Store | `senecajs/seneca-sqlite-store` | `seneca-store-test` on `node:sqlite` and on D1 through Miniflare. |
| Generation | here, on `@voxgig/sdkgen/testkit` | For each target on a solardemo-shaped fixture (planet; moon nested under planet; the `terraform` and `forbid` actions; create answering 201): the files emitted, no placeholder leaks, the "requires `devapi-data` and `devapi-access`" error, the unsupported-auth error, a cycle in `per` counts, reserved-path collisions, collection actions listed as 501, the warning for an over-large seed, and out-of-tree generation through `outside`. |
| Servers | here, in `servers.yml` (heavier, like langpack's `sdks.yml`) | Generate both servers, install, build and run each: Fastify under Node, cfw under Miniflare. Run one request script against each. |
| **Parity** | here, in `servers.yml` | The same script against both servers must give identical responses, once ids and timestamps are normalised. This is the property the Seneca layer exists to provide, so it is tested rather than assumed. |
| SDK round trip | here, in `servers.yml` | Where `ts` is generated, its live suite runs against each server using a devapi-access key. |
| Isolation | runtime and servers | Account A's writes are invisible to account B; a reset restores the seed; a revoked key answers 401 within the cache TTL. |

Two lanes, `current` and `floor`, follow infrapack's `build.yml`, and so does
its daily schedule, which is how this pack notices an sdkgen release breaking
it.

---

## 13. Risks and spikes

| risk | why it matters | spike or mitigation |
|---|---|---|
| **Seneca on workerd** | Everything in §2 depends on it, and it has not been shown. | Seneca `4.0.0-rc5`'s dependency tree needs only `util`, `events`, `fs` and `path`, all of which `nodejs_compat` provides. A scan found no `eval` or `new Function`. Still to check: the dynamic `require` of an options file in `lib/options.js` under Vite bundling; cold-start cost; bundle size. **Phase 0 go/no-go.** The fallback keeps the message patterns but runs them on a minimal patrun router, so moving to full Seneca later is mechanical. |
| **Seneca 4 is a release candidate** | Building on an RC. | Pin exactly; generated `package.json` ranges are set from the model's `deps`. Seneca 3.x is not a fallback, because splitting the business logic by platform defeats the design (D10). |
| D1 store correctness | It is new code under every write. | `seneca-store-test` on both drivers before anything depends on it. |
| Response-shape fidelity | If the mock's envelopes differ from what the SDK unwraps, every SDK call fails. | Mirror `TestFeature.ts`, share its case table, and run the SDK round trip in CI. |
| apidef field merging | apidef merges request and response fields into one list, so read-only fields cannot always be told apart. | Use `ro` where the spec sets it, fall back to name heuristics, and make it overridable per field. The terraform-provider design notes record the same gap. |
| Route shapes v1 does not serve | GraphQL points, raw bodies and server variables exist in real specs. | Answer 501 and list them in the generated README, never silently. |
| Seed size on Workers | A large seed exceeds script limits. | Warn at generation; D1-seeded tables later. |
| `custom.ts` emit-once | It must never be overwritten. | Check jostraca's support in Phase 1, with the fallback described in 5.5. |

---

## 14. Order of work

Each phase ends at a check that can be run, not at a judgement call.

0. **Spikes** (throwaway code; the findings are recorded here):
   1. Seneca 4 rc with seneca-entity in an Astro Worker on local D1. Measure
      cold start and bundle size.
   2. A prototype D1 driver against `seneca-store-test`.
   3. aontu: unify a derived base with project overrides, and check that the
      conflicts are located.
   4. `devapi.json` derived from solardemo and two real specs, checking route,
      id and transform coverage.

   *Exit:* a go/no-go on Seneca on workerd (13), and this document updated.
1. **Pack scaffold.** Manifests, gates, CI, the agent guide and README, and
   the target model files. *Exit:* `npm test` and `package check` are green;
   the generation suite stages an empty consumer.
2. **`@seneca/sqlite-store`.** *Exit:* `seneca-store-test` is green on both
   drivers.
3. **`devapi-data`**, runtime and target. *Exit:* solardemo produces CSV and
   JSON that are byte-identical across runs and validate against
   `entityDataSpec`.
4. **`devapi-access`**, runtime and target. *Exit:* the key lifecycle passes
   on `mem`, `node:sqlite` and D1.
5. **Engine and `devapi-fastify`.** *Exit:* the generated solardemo server
   passes the generated TypeScript SDK's live suite with a devapi-access key,
   and the isolation tests pass.
6. **`devapi-cfw`.** *Exit:* the same suite passes under Miniflare, the parity
   test is green, and `wrangler deploy --dry-run` succeeds.
7. **Release 0.1.0** of all three packages: the docs pass, then an OIDC
   dispatch (the manual first version as recorded).

Phases 2–4 can run in parallel once Phase 1 is done.

---

## 15. Decisions for review

| # | decision | recommendation | alternative |
|---|---|---|---|
| D1 | sdkgen kind | Four **targets**, `parity: CONSUMER` (§1) | data and access as features (does not fit; needs a new tag) |
| D2 | Where the runtime lives | Published packages: `@voxgig/devapi` in a new `voxgig/devapi` repository, and `@seneca/sqlite-store` in `senecajs` (§9) | Vendor the runtime into the generated output through `tm/` |
| D3 | Per-account storage | A copy-on-write overlay over the shared seed, in one database (§5.1) | Copy the seed per account; a database or Durable Object per account |
| D4 | Accounts | Minimal `devapi/account` | Build on `@seneca/user` |
| D5 | Hashing keys | HMAC-SHA-256 with a server pepper, through WebCrypto (§4.2) | PBKDF2, scrypt or bcrypt |
| D6 | Getting keys in v1 | CLI, admin routes guarded by a token, and a dev-mode bootstrap (§4.6) | Open signup routes |
| D7 | When data is generated | At sdkgen generation time, committed; runtime `regenerate()` as well (§3.6) | Only in the generated package's build |
| D8 | Request validation | Model-level `@voxgig/struct` specs, which match the SDK and run on Workers (§5.3) | Spec JSON Schema through precompiled ajv |
| D9 | cfw routing | A catch-all endpoint and the shared route table (§7) | Astro file-per-route |
| D10 | Seneca version | The 4.0.0 RC line, subject to spike 0.1 | 3.x |
| D11 | Server output location | In-tree defaults, with `output.path` (for example, `app/`) per project | |

### Open questions

- **Q1.** Should the servers serve the API definition at `/openapi.json`? It
  needs the definition file copied into the output. That is not reading API
  shape, but it should be checked against ADR-001's intent.
- **Q2.** Paging: should it be configured explicitly (recommended), or
  inferred from parameter names such as `limit`, `offset`, `page`, `per_page`
  and `cursor`?
- **Q3.** Naming: `devapi-cfw` or `devapi-cloudflare`? `@voxgig/devapi` or
  `@seneca/devapi`?
- **Q4.** Is a shared-sandbox mode wanted, with one overlay for everyone, for
  public demos?

---

## 16. Non-goals for v1, and later

**Not in v1:**

- GraphQL points, raw or binary bodies, and webhooks;
- HTTP Basic credentials and OAuth token exchanges, both refused at generation
  (§2). A plain bearer token is served as an API key.
- collection-level actions, which answer 501 until overridden (5.2);
- per-API error schemas, request-rate limits and usage metering;
- production-grade multi-region consistency. This is a developer API, although
  keys are handled to production standards regardless.

**Later, in rough order:**

1. A **developer-portal edition** in this pack: Astro pages for signup, key
   management and API reference, on the `devapi-cfw` deployment.
2. `seedFor('sdk-test')` wired into the TypeScript SDK's `test` feature, so
   offline SDK suites run on realistic data.
3. A seed held in a D1 table, for large datasets; a Durable Object per account
   for strong isolation.
4. Spec-level validation (D8's alternative), per-API error bodies, and
   collection-action defaults built from the spec's response schemas.
5. A generated deploy workflow for `devapi-cfw`, and request-rate limits.
