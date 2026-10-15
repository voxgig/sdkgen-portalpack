import Seneca from 'seneca'
import SenecaPromisify from 'seneca-promisify'
import SenecaEntity from 'seneca-entity'
import { env } from 'cloudflare:workers'

import { d1store } from './d1store'
import { devapiData } from './devapi-data'

let ready: Promise<any> | null = null

export function seneca(): Promise<any> {
  if (null == ready) {
    const s = Seneca({ legacy: false, log: { level: 'warn' } })
      .use(SenecaPromisify)
      .use(SenecaEntity, { mem_store: false })
      .use(d1store, { db: () => (env as any).DEVAPI_DB })
      .use(devapiData)
    ready = s.ready()
  }
  return ready
}

export async function handle(op: string, ctx: any, params: any = {}) {
  const account_id = ctx.request.headers.get('x-account') || ''
  let body = undefined
  if (['create', 'update'].includes(op)) {
    body = await ctx.request.json()
  }
  const s = await seneca()
  const res = await s.post('sys:devapi-data,entity:planet', { op, account_id, params, body })
  return new Response(JSON.stringify(res.body), {
    status: res.status,
    headers: { 'content-type': 'application/json' },
  })
}
