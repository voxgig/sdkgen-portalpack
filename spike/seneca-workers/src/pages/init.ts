import type { APIRoute } from 'astro'
import { seneca } from '../lib/seneca'

// Spike only: stands in for the programmatic init call.
export const POST: APIRoute = async (ctx) => {
  const { account_id, reset } = await ctx.request.json() as any
  const s = await seneca()
  const res = await s.post('sys:devapi-data,init:account', { account_id, reset })
  return new Response(JSON.stringify(res), { headers: { 'content-type': 'application/json' } })
}
