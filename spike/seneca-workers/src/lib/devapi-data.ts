// Prototype of the generated sys:devapi-data plugin: explicit init copies the
// seed for an account; ops are scoped to that account.
const SEED = {
  planet: [
    { rkey: 'mercury', name: 'Mercury', kind: 'rock', diameter: 4879 },
    { rkey: 'earth', name: 'Earth', kind: 'rock', diameter: 12756 },
    { rkey: 'jupiter', name: 'Jupiter', kind: 'gas', diameter: 142984 },
  ],
}

const recid = (account_id: string, rkey: string) => account_id + '/' + rkey

function out(ent: any) {
  if (null == ent) return null
  const { id, account_id, rkey, ...rest } = ent.data$(false)
  return { id: rkey, ...rest }
}

export function devapiData(this: any) {
  const seneca = this

  seneca.fix('sys:devapi-data')

  seneca.message('init:account', async function (this: any, msg: any) {
    const account_id = String(msg.account_id)
    const planet = this.entity('devapi/planet')
    if (true === msg.reset) {
      await planet.remove$({ account_id, all$: true })
    }
    for (const rec of SEED.planet) {
      await planet.make$({ id$: recid(account_id, rec.rkey), account_id, ...rec }).save$()
    }
    await this.entity('devapi/account').make$({ id$: account_id, status: 'active', init: 1 }).save$()
    return { ok: true, account_id, count: { planet: SEED.planet.length } }
  })

  seneca.message('entity:planet,op:list', async function (this: any, msg: any) {
    if (!(await initialised(this, msg.account_id))) return notInit()
    const list = await this.entity('devapi/planet').list$({ account_id: msg.account_id })
    return { status: 200, body: list.map(out) }
  })

  seneca.message('entity:planet,op:load', async function (this: any, msg: any) {
    if (!(await initialised(this, msg.account_id))) return notInit()
    const ent = await this.entity('devapi/planet').load$({ account_id: msg.account_id, rkey: msg.params.id })
    return null == ent ? { status: 404, body: { error: 'not_found' } } : { status: 200, body: out(ent) }
  })

  seneca.message('entity:planet,op:create', async function (this: any, msg: any) {
    if (!(await initialised(this, msg.account_id))) return notInit()
    const body = msg.body || {}
    const rkey = String(body.id || seneca.util.Nid())
    const ent = await this.entity('devapi/planet')
      .make$({ id$: recid(msg.account_id, rkey), account_id: msg.account_id, rkey,
        name: body.name, kind: body.kind, diameter: body.diameter })
      .save$()
    return { status: 201, body: out(ent) }
  })

  seneca.message('entity:planet,op:update', async function (this: any, msg: any) {
    if (!(await initialised(this, msg.account_id))) return notInit()
    const planet = this.entity('devapi/planet')
    const ent = await planet.load$({ account_id: msg.account_id, rkey: msg.params.id })
    if (null == ent) return { status: 404, body: { error: 'not_found' } }
    const { id, ...change } = msg.body || {}
    void id
    const saved = await ent.data$(change).save$()
    return { status: 200, body: out(saved) }
  })

  seneca.message('entity:planet,op:remove', async function (this: any, msg: any) {
    if (!(await initialised(this, msg.account_id))) return notInit()
    const planet = this.entity('devapi/planet')
    const ent = await planet.load$({ account_id: msg.account_id, rkey: msg.params.id })
    if (null == ent) return { status: 404, body: { error: 'not_found' } }
    await planet.remove$({ id: ent.id })
    return { status: 200, body: out(ent) }
  })
}

async function initialised(seneca: any, account_id: string) {
  const acc = await seneca.entity('devapi/account').load$(account_id)
  return null != acc && 1 === acc.init
}

function notInit() {
  return { status: 403, body: { error: 'account_not_initialised' } }
}
