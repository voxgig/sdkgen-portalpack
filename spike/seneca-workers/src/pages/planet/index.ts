import type { APIRoute } from 'astro'
import { handle } from '../../lib/seneca'

export const GET: APIRoute = (ctx) => handle('list', ctx)
export const POST: APIRoute = (ctx) => handle('create', ctx)
