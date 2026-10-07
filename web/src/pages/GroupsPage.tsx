import { BellOff, ChevronDown, RefreshCw, Search, ShieldAlert } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, Card, CommitTextarea, Empty, Field, Input, Notice, PageHeader, Select, Spinner, Textarea, Toggle, cx, useToast } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { useLive } from '../lib/live';
import type { GroupConfig } from '../lib/types';

function GroupEditor({ group, onSaved }: { group: GroupConfig; onSaved: (group: GroupConfig) => void }) {
  const toast = useToast();
  const { settings, saveSettings } = useLive();
  const blocked = settings?.access.blockedChats ?? [];
  const ignored = blocked.includes(group.jid);
  const [draft, setDraft] = useState(group);
  const [whitelist, setWhitelist] = useState(group.whitelist.join('\n'));
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<GroupConfig>) => setDraft(current => ({ ...current, ...patch }));

  const save = async () => {
    setSaving(true);
    try {
      const body = {
        antiLink: draft.antiLink,
        antiLinkMode: draft.antiLinkMode,
        antiLinkAction: draft.antiLinkAction,
        warnLimit: draft.warnLimit,
        whitelist: whitelist.split(/[\n,]+/).map(entry => entry.trim()).filter(Boolean),
        welcomeEnabled: draft.welcomeEnabled,
        welcomeTemplate: draft.welcomeTemplate,
        farewellEnabled: draft.farewellEnabled,
        farewellTemplate: draft.farewellTemplate
      };
      const saved = await api<{ whitelist: string[] }>(`/groups/${encodeURIComponent(group.jid)}`, { method: 'PUT', body });
      setWhitelist(saved.whitelist.join('\n'));
      onSaved({ ...draft, whitelist: saved.whitelist });
      toast(`Saved settings for ${group.name}.`);
    } catch (error) {
      toast(errorMessage(error), 'danger');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6 border-t border-line px-5 py-5">
      <Toggle
        label="Ignore this group completely"
        description="The bot does nothing here: no commands, no link filtering, no greetings, nothing recorded. Saved immediately."
        checked={ignored}
        onChange={on => saveSettings('access', { blockedChats: on ? [...blocked, group.jid] : blocked.filter(jid => jid !== group.jid) })}
      />
      {ignored && <Notice tone="warn">This group is ignored, so the settings below have no effect until you switch that off.</Notice>}
      {!group.botIsAdmin && (
        <Notice tone="warn">
          The bot is not an admin in this group, so it cannot delete links or remove members. Welcome and farewell messages still work.
        </Notice>
      )}

      <div>
        <Toggle
          label="Anti-link"
          description="Delete links posted by members. Group admins and bot owners are never filtered."
          checked={draft.antiLink}
          onChange={antiLink => set({ antiLink })}
        />
        {draft.antiLink && (
          <div className="mt-3 grid gap-4 md:grid-cols-3">
            <Field label="Block">
              <Select value={draft.antiLinkMode} onChange={event => set({ antiLinkMode: event.target.value as GroupConfig['antiLinkMode'] })}>
                <option value="whatsapp">WhatsApp invite links only</option>
                <option value="all">Every link</option>
              </Select>
            </Field>
            <Field label="Then">
              <Select value={draft.antiLinkAction} onChange={event => set({ antiLinkAction: event.target.value as GroupConfig['antiLinkAction'] })}>
                <option value="delete">Delete the message</option>
                <option value="warn">Delete and warn</option>
                <option value="kick">Delete and remove the member</option>
              </Select>
            </Field>
            {draft.antiLinkAction === 'warn' && (
              <Field label="Remove after this many warnings">
                <Input type="number" min={1} max={20} value={draft.warnLimit} onChange={event => set({ warnLimit: Number(event.target.value) })} />
              </Field>
            )}
            <div className="md:col-span-3">
              <Field label="Allowed sites" hint="One domain per line, e.g. youtube.com. Subdomains are included. This group's own invite link is always allowed.">
                <Textarea rows={3} placeholder={'youtube.com\ngithub.com'} value={whitelist} onChange={event => setWhitelist(event.target.value)} />
              </Field>
            </div>
          </div>
        )}
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <div>
          <Toggle label="Welcome new members" checked={draft.welcomeEnabled} onChange={welcomeEnabled => set({ welcomeEnabled })} />
          {draft.welcomeEnabled && (
            <Textarea className="mt-2" rows={4} value={draft.welcomeTemplate} onChange={event => set({ welcomeTemplate: event.target.value })} />
          )}
        </div>
        <div>
          <Toggle label="Say goodbye when members leave" checked={draft.farewellEnabled} onChange={farewellEnabled => set({ farewellEnabled })} />
          {draft.farewellEnabled && (
            <Textarea className="mt-2" rows={4} value={draft.farewellTemplate} onChange={event => set({ farewellTemplate: event.target.value })} />
          )}
        </div>
      </div>
      {(draft.welcomeEnabled || draft.farewellEnabled) && (
        <p className="text-xs text-muted">
          Placeholders: <code className="font-mono">{'{user}'}</code> <code className="font-mono">{'{group}'}</code>{' '}
          <code className="font-mono">{'{desc}'}</code> <code className="font-mono">{'{count}'}</code>
        </p>
      )}

      <div className="flex justify-end">
        <Button variant="primary" busy={saving} onClick={save}>
          Save group
        </Button>
      </div>
    </div>
  );
}

export function GroupsPage() {
  const { session, settings, saveSettings, directoryVersion } = useLive();
  const toast = useToast();
  const [groups, setGroups] = useState<GroupConfig[]>();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const connected = session?.status === 'connected';

  const load = useCallback(async (refresh = false) => {
    try {
      setGroups(await api<GroupConfig[]>(`/groups${refresh ? '?refresh=1' : ''}`));
    } catch (error) {
      toast(errorMessage(error), 'danger');
      setGroups(current => current ?? []);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load, directoryVersion, connected]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (groups ?? []).filter(group => !needle || group.name.toLowerCase().includes(needle));
  }, [groups, query]);

  const refresh = async () => {
    setRefreshing(true);
    await load(true);
    setRefreshing(false);
  };

  return (
    <>
      <PageHeader
        title="Groups"
        description="Per-group protection and greetings. The bot must be a group admin to delete messages or remove members."
        actions={
          <Button onClick={refresh} busy={refreshing} disabled={!connected} icon={<RefreshCw className="h-4 w-4" />}>
            Refresh
          </Button>
        }
      />

      {!groups ? (
        <div className="flex items-center gap-3 text-muted">
          <Spinner /> Loading groups…
        </div>
      ) : groups.length === 0 ? (
        <Empty
          title={connected ? 'No groups found' : 'Connect WhatsApp to see your groups'}
          hint={connected ? 'Add the linked account to a group, then press Refresh.' : 'Groups are read live from your account once the bot is connected.'}
        />
      ) : (
        <div className="space-y-4">
          <div className="relative max-w-sm">
            <Search className="pointer-events-none absolute top-3 left-3 h-4 w-4 text-muted" aria-hidden />
            <Input aria-label="Search groups" placeholder="Search groups" className="pl-9" value={query} onChange={event => setQuery(event.target.value)} />
          </div>

          {visible.map(group => {
            const expanded = open === group.jid;
            return (
              <Card key={group.jid} className="overflow-hidden">
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => setOpen(expanded ? undefined : group.jid)}
                  className="-m-5 flex w-[calc(100%+2.5rem)] items-center justify-between gap-3 p-5 text-left hover:bg-raised/60"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium">{group.name}</p>
                    <p className="text-sm text-muted">{group.size} members</p>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                    {settings?.access.blockedChats.includes(group.jid) && (
                      <Badge>
                        <BellOff className="h-3 w-3" /> Ignored
                      </Badge>
                    )}
                    {!group.botIsAdmin && (
                      <Badge tone="warn">
                        <ShieldAlert className="h-3 w-3" /> Not admin
                      </Badge>
                    )}
                    {group.antiLink && <Badge tone="good">Anti-link</Badge>}
                    {group.welcomeEnabled && <Badge tone="good">Welcome</Badge>}
                    {group.farewellEnabled && <Badge tone="good">Farewell</Badge>}
                    <ChevronDown className={cx('h-4 w-4 text-muted transition-transform', expanded && 'rotate-180')} />
                  </div>
                </button>
                {expanded && (
                  <div className="-mx-5 mt-5 -mb-5">
                    <GroupEditor
                      group={group}
                      onSaved={saved => setGroups(list => list?.map(item => (item.jid === saved.jid ? saved : item)))}
                    />
                  </div>
                )}
              </Card>
            );
          })}
          {visible.length === 0 && <p className="text-sm text-muted">No group matches "{query}".</p>}
        </div>
      )}

      {settings && (
        <Card
          className="mt-6"
          title="Default greetings"
          description="Used by groups that have welcome or farewell messages switched on without their own text. Saved when you click away."
        >
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Welcome message">
              <CommitTextarea rows={4} value={settings.groups.defaultWelcome} onCommit={defaultWelcome => saveSettings('groups', { defaultWelcome })} />
            </Field>
            <Field label="Farewell message">
              <CommitTextarea rows={4} value={settings.groups.defaultFarewell} onCommit={defaultFarewell => saveSettings('groups', { defaultFarewell })} />
            </Field>
          </div>
          <p className="mt-3 text-xs text-muted">
            Placeholders: <code className="font-mono">{'{user}'}</code> mentions the member, <code className="font-mono">{'{group}'}</code> is the group
            name, <code className="font-mono">{'{desc}'}</code> its description and <code className="font-mono">{'{count}'}</code> the member count.
          </p>
        </Card>
      )}
    </>
  );
}
