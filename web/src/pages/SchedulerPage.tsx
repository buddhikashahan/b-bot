import { Bold, CalendarClock, Code, History, Italic, Paperclip, Pause, Pencil, Play, Plus, Repeat, Search, Send, Strikethrough, Trash2, X } from 'lucide-react';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Badge, Button, Card, Empty, Field, Input, Notice, PageHeader, Select, Spinner, cx, formatDateTime, useToast } from '../components/ui';
import { api, errorMessage, upload } from '../lib/api';
import { useLive } from '../lib/live';
import type { Job, JobRun, JobStatus, TargetList, Upload } from '../lib/types';

const STATUS_TONE: Record<JobStatus, 'neutral' | 'good' | 'warn' | 'danger'> = {
  pending: 'neutral',
  active: 'good',
  running: 'warn',
  paused: 'neutral',
  completed: 'good',
  failed: 'danger'
};
const STATUS_LABEL: Record<JobStatus, string> = {
  pending: 'Scheduled',
  active: 'Active',
  running: 'Sending…',
  paused: 'Paused',
  completed: 'Sent',
  failed: 'Failed'
};
const CRON_PRESETS = [
  ['0 9 * * *', 'Every day at 09:00'],
  ['0 9 * * 1-5', 'Weekdays at 09:00'],
  ['0 9 * * 1', 'Every Monday at 09:00'],
  ['0 9 1 * *', 'First day of the month at 09:00'],
  ['0 * * * *', 'Every hour']
] as const;

/** datetime-local wants "YYYY-MM-DDTHH:mm" in local time. */
function toLocalInput(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Render WhatsApp's inline markup (*bold* _italic_ ~strike~ ```mono```) as a preview. */
function WhatsAppText({ text }: { text: string }) {
  const parts = text.split(/(```[\s\S]+?```|\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~)/g);
  return (
    <>
      {parts.map((part, index) => {
        if (part.length > 6 && part.startsWith('```') && part.endsWith('```')) {
          return (
            <code key={index} className="font-mono text-[0.9em]">
              {part.slice(3, -3)}
            </code>
          );
        }
        if (part.length > 2 && part.startsWith('*') && part.endsWith('*')) return <strong key={index}>{part.slice(1, -1)}</strong>;
        if (part.length > 2 && part.startsWith('_') && part.endsWith('_')) return <em key={index}>{part.slice(1, -1)}</em>;
        if (part.length > 2 && part.startsWith('~') && part.endsWith('~')) return <s key={index}>{part.slice(1, -1)}</s>;
        return <Fragment key={index}>{part}</Fragment>;
      })}
    </>
  );
}

function MessageEditor({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);

  /** Wrap the selection in a marker, or insert an empty pair at the caret. */
  const wrap = (marker: string) => {
    const area = ref.current;
    if (!area) return;
    const { selectionStart: start, selectionEnd: end } = area;
    const selected = value.slice(start, end);
    onChange(`${value.slice(0, start)}${marker}${selected}${marker}${value.slice(end)}`);
    requestAnimationFrame(() => {
      area.focus();
      area.setSelectionRange(start + marker.length, end + marker.length);
    });
  };

  const tools: [string, string, ReactNode][] = [
    ['*', 'Bold', <Bold key="b" className="h-4 w-4" />],
    ['_', 'Italic', <Italic key="i" className="h-4 w-4" />],
    ['~', 'Strikethrough', <Strikethrough key="s" className="h-4 w-4" />],
    ['```', 'Monospace', <Code key="c" className="h-4 w-4" />]
  ];

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="overflow-hidden rounded-lg border border-line focus-within:border-accent">
        <div className="flex gap-1 border-b border-line bg-raised px-2 py-1.5">
          {tools.map(([marker, label, icon]) => (
            <button
              key={label}
              type="button"
              title={label}
              aria-label={label}
              onClick={() => wrap(marker)}
              className="rounded p-1.5 text-muted hover:bg-panel hover:text-ink"
            >
              {icon}
            </button>
          ))}
        </div>
        <textarea
          ref={ref}
          aria-label="Message"
          rows={7}
          value={value}
          onChange={event => onChange(event.target.value)}
          placeholder="Write your message…"
          className="block w-full resize-y bg-panel px-3 py-2 text-sm leading-relaxed placeholder:text-muted/70 focus:outline-none"
        />
      </div>
      <div className="rounded-lg bg-raised p-3">
        <p className="mb-2 text-xs font-medium text-muted">Preview</p>
        <div className="max-w-sm rounded-lg rounded-tl-none bg-accent-soft px-3 py-2 text-sm break-words whitespace-pre-wrap">
          {value ? <WhatsAppText text={value} /> : <span className="text-muted">Your message will appear here.</span>}
        </div>
      </div>
    </div>
  );
}

function TargetPicker({ targets, selected, onChange }: { targets: TargetList; selected: string[]; onChange: (jids: string[]) => void }) {
  const [query, setQuery] = useState('');
  const [manual, setManual] = useState('');
  const chosen = useMemo(() => new Set(selected), [selected]);
  const names = useMemo(() => {
    const map = new Map<string, string>();
    for (const group of targets.groups) map.set(group.jid, group.name);
    for (const contact of targets.contacts) map.set(contact.jid, contact.name);
    return map;
  }, [targets]);

  const toggle = (jid: string) => onChange(chosen.has(jid) ? selected.filter(item => item !== jid) : [...selected, jid]);
  const needle = query.trim().toLowerCase();
  const matches = (name: string, jid: string) => !needle || name.toLowerCase().includes(needle) || jid.includes(needle);
  const groups = targets.groups.filter(group => matches(group.name, group.jid));
  const contacts = targets.contacts.filter(contact => matches(contact.name, contact.jid)).slice(0, 200);

  const addManual = () => {
    const digits = manual.replace(/\D/g, '');
    if (digits.length < 7) return;
    const jid = `${digits}@s.whatsapp.net`;
    if (!chosen.has(jid)) onChange([...selected, jid]);
    setManual('');
  };

  const row = (jid: string, name: string, detail: string) => (
    <label key={jid} className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-raised">
      <input type="checkbox" className="h-4 w-4 accent-(--accent)" checked={chosen.has(jid)} onChange={() => toggle(jid)} />
      <span className="min-w-0 flex-1 truncate">{name}</span>
      <span className="shrink-0 text-xs text-muted">{detail}</span>
    </label>
  );

  return (
    <div className="space-y-3">
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selected.map(jid => (
            <span key={jid} className="inline-flex items-center gap-1 rounded-full bg-accent-soft py-0.5 pr-1 pl-2.5 text-xs">
              {names.get(jid) ?? `+${jid.split('@')[0]}`}
              <button type="button" aria-label={`Remove ${names.get(jid) ?? jid}`} onClick={() => toggle(jid)} className="rounded-full p-0.5 hover:bg-panel">
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="rounded-lg border border-line">
        <div className="relative border-b border-line">
          <Search className="pointer-events-none absolute top-3 left-3 h-4 w-4 text-muted" aria-hidden />
          <input
            aria-label="Search chats"
            placeholder="Search groups and contacts"
            value={query}
            onChange={event => setQuery(event.target.value)}
            className="h-10 w-full bg-transparent pr-3 pl-9 text-sm placeholder:text-muted/70 focus:outline-none"
          />
        </div>
        <div className="max-h-56 overflow-y-auto">
          {groups.length > 0 && <p className="bg-raised px-3 py-1 text-xs font-medium text-muted">Groups</p>}
          {groups.map(group => row(group.jid, group.name, `${group.size} members`))}
          {contacts.length > 0 && <p className="bg-raised px-3 py-1 text-xs font-medium text-muted">Contacts</p>}
          {contacts.map(contact => row(contact.jid, contact.name, `+${contact.jid.split('@')[0]}`))}
          {groups.length + contacts.length === 0 && (
            <p className="px-3 py-6 text-center text-sm text-muted">
              {needle ? 'No chat matches your search.' : 'No chats synced yet. Connect WhatsApp, or add a number below.'}
            </p>
          )}
        </div>
      </div>

      <div className="flex gap-2">
        <Input
          aria-label="Add a phone number"
          inputMode="numeric"
          placeholder="Add a number, e.g. 15551234567"
          value={manual}
          onChange={event => setManual(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.preventDefault();
              addManual();
            }
          }}
        />
        <Button onClick={addManual} disabled={manual.replace(/\D/g, '').length < 7}>
          Add
        </Button>
      </div>
    </div>
  );
}

interface Draft {
  name: string;
  kind: 'once' | 'recurring';
  runAt: string;
  cron: string;
  timezone: string;
  targets: string[];
  text: string;
  maxRetries: number;
  /** undefined = keep what the job already has, null = remove it. */
  media?: Upload | null;
  existingMedia?: string;
}

function draftFrom(job?: Job): Draft {
  return {
    name: job?.name ?? '',
    kind: job?.kind ?? 'once',
    runAt: toLocalInput(job?.runAt ? new Date(job.runAt) : new Date(Date.now() + 60 * 60_000)),
    cron: job?.cron ?? CRON_PRESETS[0][0],
    timezone: job?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    targets: job?.targets ?? [],
    text: job?.text ?? '',
    maxRetries: job?.maxRetries ?? 3,
    existingMedia: job?.hasMedia ? (job.mediaName ?? 'attachment') : undefined
  };
}

function Composer({ job, targets, onClose, onSaved }: { job?: Job; targets: TargetList; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [draft, setDraft] = useState<Draft>(() => draftFrom(job));
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const set = (patch: Partial<Draft>) => setDraft(current => ({ ...current, ...patch }));

  const attachment = draft.media ? draft.media.name : draft.media === null ? undefined : draft.existingMedia;

  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    try {
      set({ media: await upload<Upload>('/uploads', file) });
    } catch (error) {
      toast(errorMessage(error), 'danger');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const body = {
        name: draft.name.trim() || (draft.text.trim().slice(0, 40) || 'Scheduled message'),
        kind: draft.kind,
        runAt: draft.kind === 'once' ? new Date(draft.runAt).toISOString() : undefined,
        cron: draft.kind === 'recurring' ? draft.cron : undefined,
        timezone: draft.kind === 'recurring' ? draft.timezone : undefined,
        targets: draft.targets,
        text: draft.text,
        maxRetries: draft.maxRetries,
        ...(draft.media
          ? { mediaId: draft.media.id, mediaName: draft.media.name, mediaMime: draft.media.mime }
          : draft.media === null
            ? { mediaId: null }
            : {})
      };
      await api(job ? `/jobs/${job.id}` : '/jobs', { method: job ? 'PUT' : 'POST', body });
      toast(job ? 'Schedule updated.' : 'Message scheduled.');
      onSaved();
    } catch (error) {
      toast(errorMessage(error), 'danger');
    } finally {
      setSaving(false);
    }
  };

  const valid = draft.targets.length > 0 && (draft.text.trim() !== '' || Boolean(attachment)) && (draft.kind === 'recurring' ? draft.cron.trim() !== '' : draft.runAt !== '');

  return (
    <Card
      title={job ? 'Edit scheduled message' : 'New scheduled message'}
      actions={
        <Button variant="ghost" size="sm" onClick={onClose} icon={<X className="h-4 w-4" />}>
          Close
        </Button>
      }
    >
      <div className="space-y-6">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Name" hint="Only you see this.">
            <Input placeholder="Monday reminder" value={draft.name} onChange={event => set({ name: event.target.value })} />
          </Field>
          <Field label="Send">
            <Select value={draft.kind} onChange={event => set({ kind: event.target.value as Draft['kind'] })}>
              <option value="once">Once, at a date and time</option>
              <option value="recurring">Repeatedly, on a schedule</option>
            </Select>
          </Field>
        </div>

        {draft.kind === 'once' ? (
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Date and time" hint="In your browser's timezone.">
              <Input type="datetime-local" value={draft.runAt} onChange={event => set({ runAt: event.target.value })} />
            </Field>
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-3">
            <Field label="Repeat">
              <Select
                value={CRON_PRESETS.some(([expression]) => expression === draft.cron) ? draft.cron : 'custom'}
                onChange={event => event.target.value !== 'custom' && set({ cron: event.target.value })}
              >
                {CRON_PRESETS.map(([expression, label]) => (
                  <option key={expression} value={expression}>
                    {label}
                  </option>
                ))}
                <option value="custom">Custom…</option>
              </Select>
            </Field>
            <Field label="Cron expression" hint="minute hour day month weekday">
              <Input className="font-mono" value={draft.cron} onChange={event => set({ cron: event.target.value })} />
            </Field>
            <Field label="Timezone">
              <Input value={draft.timezone} onChange={event => set({ timezone: event.target.value })} placeholder="Europe/London" />
            </Field>
          </div>
        )}

        <div>
          <p className="mb-1.5 text-sm font-medium">Message</p>
          <MessageEditor value={draft.text} onChange={text => set({ text })} />
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <input ref={fileRef} type="file" className="hidden" onChange={event => pickFile(event.target.files?.[0])} />
            <Button size="sm" busy={uploading} onClick={() => fileRef.current?.click()} icon={<Paperclip className="h-3.5 w-3.5" />}>
              {attachment ? 'Replace attachment' : 'Attach a file'}
            </Button>
            {attachment && (
              <span className="inline-flex min-w-0 items-center gap-1.5 text-sm">
                <span className="truncate">{attachment}</span>
                <button type="button" aria-label="Remove attachment" onClick={() => set({ media: null })} className="rounded p-0.5 text-muted hover:text-danger">
                  <X className="h-4 w-4" />
                </button>
              </span>
            )}
            <span className="text-xs text-muted">Images, video, audio or documents up to 64 MB.</span>
          </div>
        </div>

        <div>
          <p className="mb-1.5 text-sm font-medium">
            Recipients <span className="font-normal text-muted">({draft.targets.length} selected)</span>
          </p>
          <TargetPicker targets={targets} selected={draft.targets} onChange={jids => set({ targets: jids })} />
          {draft.targets.length > 20 && (
            <div className="mt-3">
              <Notice tone="warn">
                Sending the same message to many chats can get an account restricted by WhatsApp. Only message people who expect to hear from you.
              </Notice>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-end justify-between gap-4 border-t border-line pt-5">
          <div className="w-44">
            <Field label="Retries if sending fails">
              <Select value={draft.maxRetries} onChange={event => set({ maxRetries: Number(event.target.value) })}>
                {[0, 1, 2, 3, 5, 10].map(count => (
                  <option key={count} value={count}>
                    {count === 0 ? 'Do not retry' : `${count} ${count === 1 ? 'retry' : 'retries'}`}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" busy={saving} disabled={!valid || uploading} onClick={save} icon={<CalendarClock className="h-4 w-4" />}>
              {job ? 'Save changes' : 'Schedule message'}
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}

function RunHistory({ jobId }: { jobId: string }) {
  const [runs, setRuns] = useState<JobRun[]>();
  useEffect(() => {
    api<JobRun[]>(`/jobs/${jobId}/runs`).then(setRuns).catch(() => setRuns([]));
  }, [jobId]);

  if (!runs) return <Spinner className="text-muted" />;
  if (runs.length === 0) return <p className="text-sm text-muted">This job has not run yet.</p>;
  return (
    <ul className="space-y-2 text-sm">
      {runs.map(run => (
        <li key={run.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <Badge tone={run.status === 'completed' ? 'good' : run.status === 'failed' ? 'danger' : 'warn'}>{run.status}</Badge>
          <span>{formatDateTime(run.startedAt)}</span>
          <span className="text-muted">
            attempt {run.attempt} · {run.sent} sent{run.failed ? ` · ${run.failed} not delivered` : ''}
          </span>
          {run.error && <span className="w-full font-mono text-xs break-words whitespace-pre-wrap text-danger">{run.error}</span>}
        </li>
      ))}
    </ul>
  );
}

export function SchedulerPage() {
  const { jobsVersion, directoryVersion, session } = useLive();
  const toast = useToast();
  const [jobs, setJobs] = useState<Job[]>();
  const [targets, setTargets] = useState<TargetList>({ groups: [], contacts: [] });
  const [editing, setEditing] = useState<Job | 'new'>();
  const [history, setHistory] = useState<string>();
  const [confirmDelete, setConfirmDelete] = useState<string>();
  const [busy, setBusy] = useState<string>();

  const load = useCallback(() => api<Job[]>('/jobs').then(setJobs).catch(() => setJobs(current => current ?? [])), []);
  useEffect(() => {
    void load();
  }, [load, jobsVersion]);
  useEffect(() => {
    api<TargetList>('/targets').then(setTargets).catch(() => {});
  }, [directoryVersion]);

  const names = useMemo(() => {
    const map = new Map<string, string>();
    for (const group of targets.groups) map.set(group.jid, group.name);
    for (const contact of targets.contacts) map.set(contact.jid, contact.name);
    return map;
  }, [targets]);

  const act = async (job: Job, action: 'pause' | 'resume' | 'run' | 'delete') => {
    setBusy(`${job.id}:${action}`);
    try {
      if (action === 'delete') await api(`/jobs/${job.id}`, { method: 'DELETE' });
      else await api(`/jobs/${job.id}/${action}`, { method: 'POST', body: {} });
      if (action === 'run') toast(`Sending "${job.name}" now.`);
      await load();
    } catch (error) {
      toast(errorMessage(error), 'danger');
    } finally {
      setBusy(undefined);
      setConfirmDelete(undefined);
    }
  };

  const recipients = (job: Job) => {
    const first = job.targets.slice(0, 2).map(jid => names.get(jid) ?? `+${jid.split('@')[0]}`);
    return job.targets.length > 2 ? `${first.join(', ')} +${job.targets.length - 2} more` : first.join(', ');
  };

  return (
    <>
      <PageHeader
        title="Scheduler"
        description="Send messages later, on a repeating schedule, or to many chats at once. Schedules are stored in the database and survive restarts."
        actions={
          !editing && (
            <Button variant="primary" onClick={() => setEditing('new')} icon={<Plus className="h-4 w-4" />}>
              New message
            </Button>
          )
        }
      />

      <div className="space-y-6">
        {session && session.status !== 'connected' && (
          <Notice tone="warn">WhatsApp is not connected. Due messages wait and are sent as soon as the connection is back.</Notice>
        )}

        {editing && (
          <Composer
            key={editing === 'new' ? 'new' : editing.id}
            job={editing === 'new' ? undefined : editing}
            targets={targets}
            onClose={() => setEditing(undefined)}
            onSaved={() => {
              setEditing(undefined);
              void load();
            }}
          />
        )}

        {!jobs ? (
          <div className="flex items-center gap-3 text-muted">
            <Spinner /> Loading…
          </div>
        ) : jobs.length === 0 ? (
          !editing && <Empty title="Nothing scheduled" hint="Create a message to send once at a set time, or repeatedly on a schedule." />
        ) : (
          <div className="space-y-3">
            {jobs.map(job => (
              <Card key={job.id}>
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      {job.kind === 'recurring' ? <Repeat className="h-4 w-4 text-muted" aria-label="Recurring" /> : <CalendarClock className="h-4 w-4 text-muted" aria-label="One-time" />}
                      <span className="truncate font-medium">{job.name}</span>
                      <Badge tone={STATUS_TONE[job.status]}>{STATUS_LABEL[job.status]}</Badge>
                      {job.attempts > 0 && <Badge tone="warn">retry {job.attempts}/{job.maxRetries}</Badge>}
                    </div>
                    <p className="mt-1.5 line-clamp-2 text-sm break-words text-muted">
                      {job.hasMedia && `📎 ${job.mediaName ?? 'attachment'}${job.text ? ' · ' : ''}`}
                      {job.text}
                    </p>
                    <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                      <div className="flex gap-2">
                        <dt className="text-muted">To</dt>
                        <dd className="min-w-0 truncate">{recipients(job)}</dd>
                      </div>
                      <div className="flex gap-2">
                        <dt className="text-muted">{job.kind === 'recurring' ? 'Schedule' : 'When'}</dt>
                        <dd className="min-w-0 truncate">
                          {job.kind === 'recurring' ? (
                            <>
                              <code className="font-mono">{job.cron}</code>
                              {job.timezone ? ` (${job.timezone})` : ''}
                            </>
                          ) : (
                            formatDateTime(job.runAt)
                          )}
                        </dd>
                      </div>
                      {job.nextRunAt && (job.status === 'active' || job.status === 'pending') && (
                        <div className="flex gap-2">
                          <dt className="text-muted">Next</dt>
                          <dd>{formatDateTime(job.nextRunAt)}</dd>
                        </div>
                      )}
                      {job.lastRunAt && (
                        <div className="flex gap-2">
                          <dt className="text-muted">Last sent</dt>
                          <dd>
                            {formatDateTime(job.lastRunAt)}
                            {job.runCount > 1 ? ` (${job.runCount} times)` : ''}
                          </dd>
                        </div>
                      )}
                    </dl>
                    {job.lastError && <p className="mt-2 font-mono text-xs break-words whitespace-pre-wrap text-danger">{job.lastError}</p>}
                  </div>

                  <div className="flex flex-wrap gap-1.5">
                    <Button size="sm" title="Send now" busy={busy === `${job.id}:run`} disabled={job.status === 'running'} onClick={() => act(job, 'run')} icon={<Send className="h-3.5 w-3.5" />}>
                      Send now
                    </Button>
                    {(job.status === 'active' || job.status === 'pending') && (
                      <Button size="sm" busy={busy === `${job.id}:pause`} onClick={() => act(job, 'pause')} icon={<Pause className="h-3.5 w-3.5" />}>
                        Pause
                      </Button>
                    )}
                    {job.status === 'paused' && (
                      <Button size="sm" busy={busy === `${job.id}:resume`} onClick={() => act(job, 'resume')} icon={<Play className="h-3.5 w-3.5" />}>
                        Resume
                      </Button>
                    )}
                    <Button size="sm" onClick={() => setEditing(job)} disabled={job.status === 'running'} icon={<Pencil className="h-3.5 w-3.5" />}>
                      Edit
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setHistory(history === job.id ? undefined : job.id)} icon={<History className="h-3.5 w-3.5" />}>
                      History
                    </Button>
                    {confirmDelete === job.id ? (
                      <Button size="sm" variant="danger" busy={busy === `${job.id}:delete`} onClick={() => act(job, 'delete')}>
                        Confirm delete
                      </Button>
                    ) : (
                      <Button size="sm" variant="ghost" aria-label={`Delete ${job.name}`} onClick={() => setConfirmDelete(job.id)} icon={<Trash2 className="h-3.5 w-3.5" />} />
                    )}
                  </div>
                </div>
                {history === job.id && (
                  <div className={cx('mt-4 border-t border-line pt-4')}>
                    <RunHistory key={`${job.id}:${jobsVersion}`} jobId={job.id} />
                  </div>
                )}
              </Card>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
