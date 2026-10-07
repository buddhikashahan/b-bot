import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Badge, Button, Card, CommitInput, CommitTextarea, Empty, Field, Input, PageHeader, SaveIndicator, Select, Spinner, Textarea, Toggle, cx } from '../components/ui';
import { useLive } from '../lib/live';
import type { AutoReplyRule, ChatScope } from '../lib/types';

const MATCH_LABEL: Record<AutoReplyRule['match'], string> = {
  contains: 'contains',
  exact: 'is exactly',
  starts: 'starts with'
};
const SCOPE_LABEL: Record<ChatScope, string> = {
  all: 'Everywhere',
  private: 'Private chats',
  groups: 'Groups'
};
const MAX_RULES = 100;

function blankRule(): AutoReplyRule {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return { id, enabled: true, trigger: '', match: 'contains', response: '', scope: 'all' };
}

function RuleForm({ initial, onSave, onCancel }: { initial: AutoReplyRule; onSave: (rule: AutoReplyRule) => void; onCancel: () => void }) {
  const [rule, setRule] = useState(initial);
  const set = (patch: Partial<AutoReplyRule>) => setRule(current => ({ ...current, ...patch }));
  const valid = rule.trigger.trim() !== '' && rule.response.trim() !== '';

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (valid) onSave({ ...rule, trigger: rule.trigger.trim(), response: rule.response.trim() });
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid gap-4 md:grid-cols-[180px_1fr_180px]">
        <Field label="When a message">
          <Select value={rule.match} onChange={event => set({ match: event.target.value as AutoReplyRule['match'] })}>
            <option value="contains">contains</option>
            <option value="exact">is exactly</option>
            <option value="starts">starts with</option>
          </Select>
        </Field>
        <Field label="This text" hint="Upper and lower case are treated the same.">
          <Input autoFocus maxLength={200} placeholder="price" value={rule.trigger} onChange={event => set({ trigger: event.target.value })} />
        </Field>
        <Field label="In">
          <Select value={rule.scope} onChange={event => set({ scope: event.target.value as ChatScope })}>
            <option value="all">Everywhere</option>
            <option value="private">Private chats only</option>
            <option value="groups">Groups only</option>
          </Select>
        </Field>
      </div>
      <Field label="Reply with" hint="{name} is replaced with the sender's name. *bold* and _italic_ work as in WhatsApp.">
        <Textarea rows={3} maxLength={4000} placeholder="Hi {name}! Our price list is at example.com/prices" value={rule.response} onChange={event => set({ response: event.target.value })} />
      </Field>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={!valid}>
          Save rule
        </Button>
      </div>
    </form>
  );
}

export function AutoReplyPage() {
  const { settings, saveSettings, saveState, saveError } = useLive();
  const [editing, setEditing] = useState<string>();
  const [confirmDelete, setConfirmDelete] = useState<string>();

  if (!settings) {
    return (
      <div className="flex items-center gap-3 text-muted">
        <Spinner /> Loading…
      </div>
    );
  }

  const { autoReply } = settings;
  const rules = autoReply.rules;
  const saveRules = (next: AutoReplyRule[]) => saveSettings('autoReply', { rules: next });

  const upsert = async (rule: AutoReplyRule) => {
    const exists = rules.some(item => item.id === rule.id);
    const saved = await saveRules(exists ? rules.map(item => (item.id === rule.id ? rule : item)) : [...rules, rule]);
    // Adding the first rule is a clear signal the feature should be on.
    if (saved && !exists && rules.length === 0 && !autoReply.enabled) await saveSettings('autoReply', { enabled: true });
    if (saved) setEditing(undefined);
  };

  return (
    <>
      <PageHeader
        title="Auto-replies"
        description="Answer common messages automatically, and let people know when you are away."
        actions={<SaveIndicator state={saveState} error={saveError} />}
      />

      <div className="space-y-6">
        <Card
          title="Keyword replies"
          description="The first rule that matches a message answers it. Commands always take priority, and blocked people never get a reply."
          actions={
            editing !== 'new' &&
            rules.length < MAX_RULES && (
              <Button variant="primary" size="sm" onClick={() => setEditing('new')} icon={<Plus className="h-3.5 w-3.5" />}>
                Add rule
              </Button>
            )
          }
        >
          <Toggle label="Send keyword replies" checked={autoReply.enabled} onChange={enabled => saveSettings('autoReply', { enabled })} />

          <div className="mt-3 space-y-3 border-t border-line pt-4">
            {editing === 'new' && (
              <div className="rounded-xl border border-accent/40 bg-accent-soft/30 p-4">
                <RuleForm initial={blankRule()} onSave={upsert} onCancel={() => setEditing(undefined)} />
              </div>
            )}

            {rules.length === 0 && editing !== 'new' && (
              <Empty title="No rules yet" hint='For example: when a message contains "price", reply with your price list.' />
            )}

            {rules.map(rule =>
              editing === rule.id ? (
                <div key={rule.id} className="rounded-xl border border-accent/40 bg-accent-soft/30 p-4">
                  <RuleForm initial={rule} onSave={upsert} onCancel={() => setEditing(undefined)} />
                </div>
              ) : (
                <div key={rule.id} className={cx('flex flex-wrap items-start justify-between gap-3 rounded-xl border border-line p-4', !rule.enabled && 'opacity-60')}>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm">
                      <span className="text-muted">Message {MATCH_LABEL[rule.match]}</span> <strong className="break-words">"{rule.trigger}"</strong>{' '}
                      <Badge>{SCOPE_LABEL[rule.scope]}</Badge>
                    </p>
                    <p className="mt-1.5 line-clamp-3 text-sm break-words whitespace-pre-wrap text-muted">{rule.response}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={rule.enabled}
                      aria-label={`${rule.enabled ? 'Disable' : 'Enable'} rule for ${rule.trigger}`}
                      onClick={() => saveRules(rules.map(item => (item.id === rule.id ? { ...item, enabled: !item.enabled } : item)))}
                      className={cx('relative h-6 w-11 rounded-full transition-colors', rule.enabled ? 'bg-accent' : 'bg-line')}
                    >
                      <span className={cx('absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform', rule.enabled && 'translate-x-5')} />
                    </button>
                    <Button size="sm" variant="ghost" aria-label={`Edit rule for ${rule.trigger}`} onClick={() => setEditing(rule.id)} icon={<Pencil className="h-3.5 w-3.5" />} />
                    {confirmDelete === rule.id ? (
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => {
                          setConfirmDelete(undefined);
                          void saveRules(rules.filter(item => item.id !== rule.id));
                        }}
                      >
                        Delete
                      </Button>
                    ) : (
                      <Button size="sm" variant="ghost" aria-label={`Delete rule for ${rule.trigger}`} onClick={() => setConfirmDelete(rule.id)} icon={<Trash2 className="h-3.5 w-3.5" />} />
                    )}
                  </div>
                </div>
              )
            )}
          </div>
        </Card>

        <Card
          title="Away message"
          description="Sent once to anyone who writes to you privately, then not again until the pause below has passed. Never sent in groups, and skipped whenever the AI assistant answers the message."
        >
          <Toggle label="Send an away message" checked={autoReply.awayEnabled} onChange={awayEnabled => saveSettings('autoReply', { awayEnabled })} />
          <div className="mt-3 grid gap-4 border-t border-line pt-4 md:grid-cols-[1fr_220px]">
            <Field label="Message" hint="{name} is replaced with the sender's name.">
              <CommitTextarea rows={3} maxLength={2000} value={autoReply.awayMessage} onCommit={awayMessage => saveSettings('autoReply', { awayMessage })} />
            </Field>
            <Field label="Pause between replies (minutes)" hint="Per chat. 240 = at most every 4 hours.">
              <CommitInput
                type="number"
                min={1}
                max={10080}
                value={autoReply.awayCooldownMinutes}
                onCommit={value => saveSettings('autoReply', { awayCooldownMinutes: Math.min(10_080, Math.max(1, Math.round(Number(value)) || 1)) })}
              />
            </Field>
          </div>
        </Card>
      </div>
    </>
  );
}
