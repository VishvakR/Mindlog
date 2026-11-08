import { MindlogClient } from '@mindlog/sdk';

/**
 * An assistant that reads a user's todos: its API key and the user's token
 * give a delegated token, so the collection rules apply as that user.
 * Usage: MINDLOG_URL=… MINDLOG_API_KEY=mlk_… USER_EMAIL=… USER_PASSWORD=… node src/agent.ts
 */
export async function summarize(url: string, apiKey: string, userToken: string): Promise<string> {
  const agent = new MindlogClient(url);
  agent.authStore.save(await agent.delegate(apiKey, userToken), null);
  const todos = await agent
    .collection('todos')
    .getFullList({ filter: 'done = false', sort: 'created' });
  return todos.length === 0
    ? 'Nothing left to do.'
    : `${String(todos.length)} open: ${todos.map((t) => String(t['title'])).join(', ')}`;
}

if (process.argv[1]?.endsWith('agent.ts')) {
  const url = process.env['MINDLOG_URL'] ?? 'http://127.0.0.1:8090';
  const user = new MindlogClient(url);
  await user
    .collection('users')
    .authWithPassword(process.env['USER_EMAIL'] ?? '', process.env['USER_PASSWORD'] ?? '');
  console.log(await summarize(url, process.env['MINDLOG_API_KEY'] ?? '', user.authStore.token));
}
