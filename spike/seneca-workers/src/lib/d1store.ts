// Prototype only: the smallest seneca-entity store over a D1 binding.
type Q = Record<string, any>

export function d1store(this: any, options: { db: () => any }) {
  const seneca = this
  const init = seneca.export('entity/init')

  const table = (ent: any) => {
    const c = ent.canon$({ object: true })
    return [c.base, c.name].filter(Boolean).join('_')
  }

  const where = (q: Q) => {
    const keys = Object.keys(q).filter((k) => !k.endsWith('$'))
    return {
      sql: 0 === keys.length ? '' : ' WHERE ' + keys.map((k) => `${k} = ?`).join(' AND '),
      vals: keys.map((k) => q[k]),
    }
  }

  const store = {
    name: 'd1-store',

    save: function (this: any, msg: any, reply: any) {
      const ent = msg.ent
      const data = ent.data$(false)
      if (null == data.id) {
        data.id = null != ent.id$ ? ent.id$ : seneca.util.Nid()
      }
      const cols = Object.keys(data)
      const sql = `INSERT INTO ${table(ent)} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})` +
        ` ON CONFLICT(id) DO UPDATE SET ${cols.filter((c) => 'id' !== c).map((c) => `${c}=excluded.${c}`).join(',')}`
      options.db().prepare(sql).bind(...cols.map((c) => data[c] ?? null)).run()
        .then(() => reply(null, ent.make$(data)))
        .catch(reply)
    },

    load: function (this: any, msg: any, reply: any) {
      const w = where(msg.q || {})
      options.db().prepare(`SELECT * FROM ${table(msg.qent)}${w.sql} LIMIT 1`).bind(...w.vals).first()
        .then((row: any) => reply(null, row ? msg.qent.make$(row) : null))
        .catch(reply)
    },

    list: function (this: any, msg: any, reply: any) {
      const w = where(msg.q || {})
      options.db().prepare(`SELECT * FROM ${table(msg.qent)}${w.sql}`).bind(...w.vals).all()
        .then((res: any) => reply(null, res.results.map((row: any) => msg.qent.make$(row))))
        .catch(reply)
    },

    remove: function (this: any, msg: any, reply: any) {
      const q = msg.q || {}
      const w = where(q)
      const limit = true === q.all$ ? '' : ` AND rowid IN (SELECT rowid FROM ${table(msg.qent)}${w.sql} LIMIT 1)`
      const sql = `DELETE FROM ${table(msg.qent)}${w.sql || ' WHERE 1=1'}${limit}`
      options.db().prepare(sql).bind(...w.vals, ...(true === q.all$ ? [] : w.vals)).run()
        .then(() => reply(null, null))
        .catch(reply)
    },

    close: function (this: any, _msg: any, reply: any) { reply() },
    native: function (this: any, _msg: any, reply: any) { reply(null, options.db()) },
  }

  const meta = init(seneca, options, store)
  return { name: store.name, tag: meta.tag }
}
