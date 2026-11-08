interface Migration {
  save(input: Record<string, unknown>): Promise<void>;
}

const owner = "@request.auth.id != '' && user = @request.auth.id";

/** Users sign themselves up; each todo is visible only to its owner, and to agents acting for them. */
export default async function migrate(m: Migration): Promise<void> {
  await m.save({
    name: 'users',
    type: 'auth',
    fields: [{ name: 'name', type: 'text' }],
    listRule: 'id = @request.auth.id',
    viewRule: 'id = @request.auth.id',
    createRule: '',
    updateRule: 'id = @request.auth.id',
  });
  await m.save({
    name: 'todos',
    fields: [
      { name: 'title', type: 'text', required: true, max: 200 },
      { name: 'done', type: 'bool' },
      { name: 'user', type: 'relation', collection: 'users', required: true, cascadeDelete: true },
      {
        name: 'attachment',
        type: 'file',
        mimeTypes: ['image/png', 'image/jpeg', 'application/pdf', 'text/plain'],
        thumbs: ['96x96'],
      },
    ],
    indexes: [{ name: 'by_user', fields: ['user'] }],
    listRule: owner,
    viewRule: owner,
    createRule: "@request.auth.id != '' && @request.body.user = @request.auth.id",
    updateRule: `${owner} && @request.body.user:changed = false`,
    deleteRule: owner,
  });
}
