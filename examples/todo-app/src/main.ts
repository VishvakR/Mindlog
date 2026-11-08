import type { RecordModel } from '@mindlog/sdk';
import { ClientError, MindlogClient } from '@mindlog/sdk';

const client = new MindlogClient(location.origin, { storage: localStorage });
const users = client.collection('users');
const todos = client.collection('todos');
const app = document.querySelector<HTMLElement>('#app') as HTMLElement;

let items: RecordModel[] = [];
let fileToken = '';
let stop: (() => Promise<void>) | undefined;

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  Object.assign(e, props);
  e.append(...children);
  return e;
}

function explain(e: unknown): string {
  if (!(e instanceof ClientError)) return e instanceof Error ? e.message : String(e);
  const fields = Object.entries(e.fields).map(([k, v]) => `${k}: ${v}`);
  return fields.length > 0 ? fields.join('; ') : e.message;
}

/** Runs an action and shows what went wrong next to the form. */
const guarded = (alert: HTMLElement, action: () => Promise<void>) => {
  alert.textContent = '';
  action().catch((e: unknown) => {
    alert.textContent = explain(e);
  });
};

function showLogin(): void {
  const alert = element('p', { role: 'alert' });
  const email = element('input', {
    type: 'email',
    placeholder: 'Email',
    required: true,
    ariaLabel: 'Email',
  });
  const password = element('input', {
    type: 'password',
    placeholder: 'Password (8+ characters)',
    required: true,
    ariaLabel: 'Password',
  });
  const signIn = () => users.authWithPassword(email.value, password.value).then(showTodos);
  const form = element(
    'form',
    {
      onsubmit: (e) => {
        e.preventDefault();
        guarded(alert, signIn);
      },
    },
    email,
    password,
    element('button', { type: 'submit' }, 'Sign in'),
    element(
      'button',
      {
        type: 'button',
        onclick: () => {
          guarded(alert, async () => {
            await users.create({
              email: email.value,
              password: password.value,
              passwordConfirm: password.value,
            });
            await signIn();
          });
        },
      },
      'Sign up',
    ),
  );
  app.replaceChildren(element('h1', {}, 'Todos'), form, alert);
}

function row(todo: RecordModel, alert: HTMLElement): HTMLElement {
  const file = typeof todo['attachment'] === 'string' ? todo['attachment'] : '';
  const preview = /\.(png|jpe?g)$/i.test(file)
    ? [
        element('img', {
          src: client.fileUrl(todo, file, {
            collection: 'todos',
            token: fileToken,
            thumb: '96x96',
          }),
          alt: file,
        }),
      ]
    : file
      ? [
          element(
            'a',
            { href: client.fileUrl(todo, file, { collection: 'todos', token: fileToken }) },
            'file',
          ),
        ]
      : [];
  return element(
    'li',
    { className: todo['done'] === true ? 'done' : '' },
    element('input', {
      type: 'checkbox',
      checked: todo['done'] === true,
      ariaLabel: `Done: ${String(todo['title'])}`,
      onchange: (e) => {
        const done = (e.target as HTMLInputElement).checked;
        guarded(alert, async () => {
          await todos.update(todo.id, { done });
        });
      },
    }),
    element('span', {}, String(todo['title'])),
    ...preview,
    element(
      'button',
      {
        ariaLabel: `Delete ${String(todo['title'])}`,
        onclick: () => {
          guarded(alert, () => todos.delete(todo.id));
        },
      },
      '✕',
    ),
  );
}

async function showTodos(): Promise<void> {
  const alert = element('p', { role: 'alert' });
  const list = element('ul');
  const render = () => {
    list.replaceChildren(...items.map((t) => row(t, alert)));
  };
  const title = element('input', {
    type: 'text',
    placeholder: 'What needs doing?',
    required: true,
    ariaLabel: 'New todo',
  });
  const attachment = element('input', { type: 'file', ariaLabel: 'Attachment' });
  const form = element(
    'form',
    {
      onsubmit: (e) => {
        e.preventDefault();
        guarded(alert, async () => {
          const body = new FormData();
          body.append('title', title.value);
          body.append('user', client.authStore.record?.id ?? '');
          const file = attachment.files?.[0];
          if (file) body.append('attachment', file);
          await todos.create(body);
          form.reset();
        });
      },
    },
    title,
    attachment,
    element('button', { type: 'submit' }, 'Add'),
  );
  const signOut = element(
    'button',
    {
      onclick: () => {
        void stop?.();
        client.authStore.clear();
        showLogin();
      },
    },
    'Sign out',
  );
  app.replaceChildren(
    element('header', {}, element('h1', {}, 'Todos'), signOut),
    element('p', {}, String(client.authStore.record?.['email'] ?? '')),
    form,
    alert,
    list,
  );
  fileToken = await client.getFileToken();
  items = await todos.getFullList({ sort: '-created' });
  render();
  // Live updates come through the same rules: only this user's changes arrive.
  stop = await todos.subscribe('*', (e) => {
    void (async () => {
      fileToken = await client.getFileToken();
      items = items.filter((t) => t.id !== e.record.id);
      if (e.action !== 'delete') items.unshift(e.record);
      render();
    })();
  });
}

if (client.authStore.isValid) {
  showTodos().catch(() => {
    client.authStore.clear();
    showLogin();
  });
} else showLogin();
