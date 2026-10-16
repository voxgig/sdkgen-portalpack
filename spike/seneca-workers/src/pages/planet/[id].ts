import type { APIRoute } from 'astro'
import { handle } from '../../lib/seneca'

export const GET: APIRoute = (ctx) => handle('load', ctx, ctx.params)
export const PATCH: APIRoute = (ctx) => handle('update', ctx, ctx.params)
export const DELETE: APIRoute = (ctx) => handle('remove', ctx, ctx.params)
