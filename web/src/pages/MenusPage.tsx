import { ArrowDown, ArrowUp, ListOrdered, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { WhatsAppText } from '../components/shared';
import { Badge, Button, Card, Empty, Field, Input, Notice, PageHeader, Select, Spinner, Textarea, cx, useToast } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { useLive } from '../lib/live';
import type { ChatScope, CustomMenu, CustomMenuOption } from '../lib/types';

type Draft = Omit<CustomMenu, 'id'> & { id?: string };

const MATCH_LABEL: Record<CustomMenu['match'], string> = { exact: 'is exactly', contains: 'contains', starts: 'starts with' };
const SCOPE_LABEL: Record<ChatScope, string> = { private: 'Private chats', groups: 'Groups', all: 'Everywhere' };
const MAX_OPTIONS = 20;

function blankMenu(): Draft {
  return {
    name: '',
    enabled: true,
    trigger: '',
    match: 'exact',
    scope: 'private',
    title: '',
    body: 'Hello {name}! How can I help?',
    options: [
      { label: '', type: 'text', value: '' },
      { label: '', type: 'text', value: '' }
    ]
  };
}

/** What the menu will look like in WhatsApp. */
function Preview({ menu }: { menu: Draft }) {
  const lines = [
    `╭─「 📋 *${menu.title || 'Menu title'}* 」`,
    ...(menu.body ? menu.body.replaceAll('{name}', 'Kasun').split('\n').map(line => `│ ${line}`) : []),
    '╰───────────────',
    '',
    ...menu.options.map((option, index) => `*${index + 1}.* ${option.label || '…'}`),
    '',
    '> _Reply to this message with a number_'
  ];
  return (
    <div className="rounded-lg bg-raised p-3">
      <p className="mb-2 text-xs font-medium text-muted">Preview</p>
      <div className="rounded-lg rounded-tl-none bg-accent-soft px-3 py-2 text-sm break-words whitespace-pre-wrap">
        <WhatsAppText text={lines.join('\n')} />
      </div>
    </div>
  );
}

function Editor({ initial, others, prefix, onSaved, onCancel }: { initial: Draft; others: CustomMenu[]; prefix: string; onSaved: () => void; onCancel: () => void }) {
  const toast = useToast();
  const [menu, setMenu] = useState(initial);
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<Draft>) => setMenu(current => ({ ...current, ...patch }));
  const setOption = (index: number, patch: Partial<CustomMenuOption>) =>
    set({ options: menu.options.map((option, position) => (position === index ? { ...option, ...patch } : option)) });
  const move = (index: number, by: number) => {
    const options = [...menu.options];
    [options[index], options[index + by]] = [options[index + by], options[index]];
    set({ options });
  };

  const complete = menu.trigger.trim() && menu.title.trim() && menu.options.length > 0 && menu.options.every(option => option.label.trim() && option.value.trim());

  const save = async () => {
    setSaving(true);
    try {
      const body = { ...menu, name: menu.name.trim() || menu.title.trim() };
      await api(menu.id ? `/menus/${menu.id}` : '/menus', { method: menu.id ? 'PUT' : 'POST', body });
      toast(menu.id ? 'Menu updated.' : 'Menu created.');
      onSaved();
    } catch (error) {
      toast(errorMessage(error), 'danger');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card
      title={menu.id ? 'Edit menu' : 'New menu'}
      actions={
        <Button variant="ghost" size="sm" onClick={onCancel} icon={<X className="h-4 w-4" />}>
          Close
        </Button>
      }
    >
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-5">
          <div className="grid gap-4 md:grid-cols-[170px_minmax(0,1fr)_170px]">
            <Field label="When a message">
              <Select value={menu.match} onChange={event => set({ match: event.target.value as CustomMenu['match'] })}>
                <option value="exact">is exactly</option>
                <option value="contains">contains</option>
                <option value="starts">starts with</option>
              </Select>
            </Field>
            <Field label="This text" hint="Upper and lower case are treated the same.">
              <Input autoFocus maxLength={100} placeholder="hi" value={menu.trigger} onChange={event => set({ trigger: event.target.value })} />
            </Field>
            <Field label="In">
              <Select value={menu.scope} onChange={event => set({ scope: event.target.value as ChatScope })}>
                <option value="private">Private chats</option>
                <option value="groups">Groups</option>
                <option value="all">Everywhere</option>
              </Select>
            </Field>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Menu title">
              <Input maxLength={80} placeholder="Sunrise Bakery" value={menu.title} onChange={event => set({ title: event.target.value })} />
            </Field>
            <Field label="Greeting" hint="{name} becomes the sender's name. Optional.">
              <Textarea rows={2} maxLength={2000} value={menu.body} onChange={event => set({ body: event.target.value })} />
            </Field>
          </div>

          <div>
            <p className="mb-2 text-sm font-medium">Options</p>
            <ol className="space-y-3">
              {menu.options.map((option, index) => (
                <li key={index} className="rounded-xl border border-line p-3">
                  <div className="flex items-start gap-3">
                    <span className="mt-2 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent">{index + 1}</span>
                    <div className="grid min-w-0 flex-1 gap-3 md:grid-cols-[1fr_200px]">
                      <Input aria-label={`Label of option ${index + 1}`} maxLength={80} placeholder="What people see, e.g. Prices" value={option.label} onChange={event => setOption(index, { label: event.target.value })} />
                      <Select aria-label={`What option ${index + 1} does`} value={option.type} onChange={event => setOption(index, { type: event.target.value as CustomMenuOption['type'], value: '' })}>
                        <option value="text">Send a reply</option>
                        <option value="menu">Open another menu</option>
                        <option value="command">Run a command</option>
                      </Select>
                      <div className="md:col-span-2">
                        {option.type === 'text' && (
                          <Textarea aria-label={`Reply for option ${index + 1}`} rows={2} maxLength={3000} placeholder="The message to send back" value={option.value} onChange={event => setOption(index, { value: event.target.value })} />
                        )}
                        {option.type === 'menu' &&
                          (others.length ? (
                            <Select aria-label={`Menu opened by option ${index + 1}`} value={option.value} onChange={event => setOption(index, { value: event.target.value })}>
                              <option value="">Choose a menu…</option>
                              {others.map(other => (
                                <option key={other.id} value={other.id}>
                                  {other.title}
                                </option>
                              ))}
                            </Select>
                          ) : (
                            <p className="text-sm text-muted">Create the other menu first, then come back and link it here.</p>
                          ))}
                        {option.type === 'command' && (
                          <Input
                            aria-label={`Command for option ${index + 1}`}
                            className="font-mono"
                            placeholder={`${prefix}owner`}
                            value={option.value}
                            onChange={event => setOption(index, { value: event.target.value })}
                          />
                        )}
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-col gap-1">
                      <button type="button" aria-label={`Move option ${index + 1} up`} disabled={index === 0} onClick={() => move(index, -1)} className="rounded p-1 text-muted hover:bg-raised disabled:opacity-30">
                        <ArrowUp className="h-4 w-4" />
                      </button>
                      <button type="button" aria-label={`Move option ${index + 1} down`} disabled={index === menu.options.length - 1} onClick={() => move(index, 1)} className="rounded p-1 text-muted hover:bg-raised disabled:opacity-30">
                        <ArrowDown className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Remove option ${index + 1}`}
                        disabled={menu.options.length === 1}
                        onClick={() => set({ options: menu.options.filter((_, position) => position !== index) })}
                        className="rounded p-1 text-muted hover:bg-raised hover:text-danger disabled:opacity-30"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ol>
            {menu.options.length < MAX_OPTIONS && (
              <Button className="mt-3" size="sm" onClick={() => set({ options: [...menu.options, { label: '', type: 'text', value: '' }] })} icon={<Plus className="h-3.5 w-3.5" />}>
                Add option
              </Button>
            )}
          </div>

          <div className="flex justify-end gap-2 border-t border-line pt-4">
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button variant="primary" busy={saving} disabled={!complete} onClick={save}>
              {menu.id ? 'Save menu' : 'Create menu'}
            </Button>
          </div>
        </div>

        <Preview menu={menu} />
      </div>
    </Card>
  );
}

export function MenusPage() {
  const { settings } = useLive();
  const toast = useToast();
  const [menus, setMenus] = useState<CustomMenu[]>();
  const [editing, setEditing] = useState<Draft>();
  const [confirmDelete, setConfirmDelete] = useState<string>();
  const prefix = settings?.commands.prefix ?? '.';

  const load = useCallback(() => api<CustomMenu[]>('/menus').then(setMenus).catch(() => setMenus(current => current ?? [])), []);
  useEffect(() => {
    void load();
  }, [load]);

  const update = async (menu: CustomMenu, patch: Partial<CustomMenu>) => {
    try {
      await api(`/menus/${menu.id}`, { method: 'PUT', body: { ...menu, ...patch } });
      await load();
    } catch (error) {
      toast(errorMessage(error), 'danger');
    }
  };

  const remove = async (id: string) => {
    setConfirmDelete(undefined);
    try {
      await api(`/menus/${id}`, { method: 'DELETE' });
      await load();
    } catch (error) {
      toast(errorMessage(error), 'danger');
    }
  };

  return (
    <>
      <PageHeader
        title="Menus"
        description="Build numbered menus. People reply with a number and the bot answers, opens another menu, or runs a command."
        actions={
          !editing && (
            <Button variant="primary" onClick={() => setEditing(blankMenu())} icon={<Plus className="h-4 w-4" />}>
              New menu
            </Button>
          )
        }
      />

      <div className="space-y-6">
        {!editing && (
          <Notice>
            <p className="font-medium">How it works</p>
            <p className="mt-1">
              When someone sends the trigger text (for example "hi"), the bot sends your menu. They <strong>reply with a number</strong> to pick an option; in a
              private chat simply typing the number works too. The bot's own <code className="font-mono">{prefix}menu</code> works the same way.
            </p>
          </Notice>
        )}

        {editing && (
          <Editor
            key={editing.id ?? 'new'}
            initial={editing}
            others={(menus ?? []).filter(menu => menu.id !== editing.id)}
            prefix={prefix}
            onCancel={() => setEditing(undefined)}
            onSaved={() => {
              setEditing(undefined);
              void load();
            }}
          />
        )}

        {!menus ? (
          <div className="flex items-center gap-3 text-muted">
            <Spinner /> Loading…
          </div>
        ) : menus.length === 0 ? (
          !editing && <Empty title="No menus yet" hint='Try a welcome menu: trigger "hi", with options such as Prices, Opening hours and Talk to a person.' />
        ) : (
          <div className="space-y-3">
            {menus.map(menu => (
              <Card key={menu.id} className={cx(!menu.enabled && 'opacity-60')}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <ListOrdered className="h-4 w-4 text-muted" aria-hidden />
                      <span className="truncate font-medium">{menu.title}</span>
                      <Badge>{SCOPE_LABEL[menu.scope]}</Badge>
                    </div>
                    <p className="mt-1.5 text-sm text-muted">
                      Sent when a message {MATCH_LABEL[menu.match]} <strong className="text-ink">"{menu.trigger}"</strong>
                    </p>
                    <ol className="mt-2 space-y-0.5 text-sm">
                      {menu.options.map((option, index) => (
                        <li key={index} className="truncate">
                          <span className="font-semibold">{index + 1}.</span> {option.label}{' '}
                          <span className="text-muted">
                            → {option.type === 'text' ? 'reply' : option.type === 'menu' ? `menu "${menus.find(other => other.id === option.value)?.title ?? 'deleted'}"` : option.value}
                          </span>
                        </li>
                      ))}
                    </ol>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={menu.enabled}
                      aria-label={`${menu.enabled ? 'Disable' : 'Enable'} menu ${menu.title}`}
                      onClick={() => update(menu, { enabled: !menu.enabled })}
                      className={cx('relative h-6 w-11 rounded-full transition-colors', menu.enabled ? 'bg-accent' : 'bg-line')}
                    >
                      <span className={cx('absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform', menu.enabled && 'translate-x-5')} />
                    </button>
                    <Button size="sm" variant="ghost" aria-label={`Edit menu ${menu.title}`} onClick={() => setEditing(menu)} icon={<Pencil className="h-3.5 w-3.5" />} />
                    {confirmDelete === menu.id ? (
                      <Button size="sm" variant="danger" onClick={() => remove(menu.id)}>
                        Delete
                      </Button>
                    ) : (
                      <Button size="sm" variant="ghost" aria-label={`Delete menu ${menu.title}`} onClick={() => setConfirmDelete(menu.id)} icon={<Trash2 className="h-3.5 w-3.5" />} />
                    )}
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
