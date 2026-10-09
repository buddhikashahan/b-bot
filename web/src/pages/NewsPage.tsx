import { Send } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { ChatSearch } from '../components/shared';
import { Badge, Button, Card, Chips, CommitInput, Field, Input, Notice, PageHeader, SaveIndicator, Segmented, Spinner, Toggle, relativeTime, useToast } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { useLive } from '../lib/live';
import type { NewsStatus, Settings, TargetList } from '../lib/types';

type News = Settings['news'];

const TOPICS: { id: News['categories'][number]; label: string }[] = [
  { id: '2', label: 'Incidents' },
  { id: '5', label: 'Statements' },
  { id: '4', label: 'Announcements' },
  { id: '3', label: 'Voice recordings' }
];

/** A chat ID typed by hand, for chats that are not in the synced lists (channels, new numbers). */
function AddChat({ onAdd }: { onAdd: (jid: string) => void }) {
  const [value, setValue] = useState('');
  const typed = value.trim();
  const digits = typed.replace(/\D/g, '');
  const jid = /^\d{5,20}(-\d{5,20})?@(s\.whatsapp\.net|g\.us|lid|newsletter)$/.test(typed)
    ? typed
    : !typed.includes('@') && digits.length >= 10 && digits.length <= 15 && !digits.startsWith('0')
      ? `${digits}@s.whatsapp.net`
      : undefined;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!jid) return;
    onAdd(jid);
    setValue('');
  };
  return (
    <form onSubmit={submit} className="flex gap-2">
      <Input aria-label="Number or chat ID" placeholder="Number with country code, or a chat ID" value={value} onChange={event => setValue(event.target.value)} />
      <Button type="submit" disabled={!jid}>
        Add
      </Button>
    </form>
  );
}

export function NewsPage() {
  const { settings, saveSettings, saveState, saveError, directoryVersion, session } = useLive();
  const toast = useToast();
  const [targets, setTargets] = useState<TargetList>({ groups: [], contacts: [] });
  const [status, setStatus] = useState<NewsStatus>();
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    api<TargetList>('/targets').then(setTargets).catch(() => {});
  }, [directoryVersion, session?.status]);

  const refresh = useCallback(() => {
    api<NewsStatus>('/news').then(setStatus).catch(() => {});
  }, []);
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 30_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const names = useMemo(() => new Map([...targets.groups.map(group => [group.jid, group.name] as const), ...targets.contacts.map(contact => [contact.jid, contact.name] as const)]), [targets]);

  if (!settings) {
    return (
      <div className="flex items-center gap-3 text-muted">
        <Spinner /> Loading…
      </div>
    );
  }

  const { news, commands } = settings;
  const save = (patch: Partial<News>) => saveSettings('news', patch);
  const label = (jid: string) => names.get(jid) ?? (jid.endsWith('@s.whatsapp.net') ? `+${jid.split('@')[0]}` : jid.endsWith('@newsletter') ? `Channel ${jid.split('@')[0]}` : jid);
  const addChat = (jid: string) => !news.chats.includes(jid) && save({ chats: [...news.chats, jid] });
  const toggleTopic = (id: News['categories'][number]) => save({ categories: news.categories.includes(id) ? news.categories.filter(item => item !== id) : [...news.categories, id] });
  const connected = session?.status === 'connected';

  const sendTest = async () => {
    setTesting(true);
    try {
      const result = await api<{ delivered: number; chats: number; title: string }>('/news/test', { method: 'POST' });
      toast(result.delivered ? `Sent "${result.title.slice(0, 60)}" to ${result.delivered} of ${result.chats} chats.` : 'The story could not be delivered to any chat.', result.delivered ? 'good' : 'danger');
      refresh();
    } catch (error) {
      toast(errorMessage(error), 'danger');
    } finally {
      setTesting(false);
    }
  };

  return (
    <>
      <PageHeader
        title="News"
        description="Sri Lankan news from Helakuru Esana, in Sinhala and English: on request with a command, or posted to your chats the moment it is published."
        actions={<SaveIndicator state={saveState} error={saveError} />}
      />

      <div className="grid gap-6">
        <Card
          title="News alerts"
          description="Every new story is posted to the chats below as soon as it is published, with its picture and a link."
          actions={news.alerts ? <Badge tone={news.chats.length ? (status?.quiet ? 'warn' : 'good') : 'warn'}>{news.chats.length ? (status?.quiet ? 'Quiet hours' : 'On') : 'No chat chosen'}</Badge> : <Badge>Off</Badge>}
        >
          <Toggle label="Send news alerts" description={`From WhatsApp: ${commands.prefix}newsalerts on and ${commands.prefix}newsalerts off.`} checked={news.alerts} onChange={alerts => save({ alerts })} />

          <div className="mt-4 space-y-4 border-t border-line pt-4">
            <div>
              <p className="mb-2 text-sm font-medium">Chats that get the alerts</p>
              <Chips empty="No chat chosen yet. Pick a group or a contact below." items={news.chats.map(jid => ({ key: jid, label: label(jid) }))} onRemove={jid => save({ chats: news.chats.filter(item => item !== jid) })} />
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              <ChatSearch
                items={targets.groups.map(group => ({ jid: group.jid, name: group.name, detail: `${group.size} members` }))}
                exclude={news.chats}
                placeholder={targets.groups.length ? 'Search your groups' : 'Connect WhatsApp to list your groups'}
                onPick={addChat}
              />
              <ChatSearch items={targets.contacts.map(contact => ({ jid: contact.jid, name: contact.name, detail: `+${contact.jid.split('@')[0]}` }))} exclude={news.chats} placeholder="Search your contacts" onPick={addChat} />
              <AddChat onAdd={addChat} />
            </div>
            <p className="text-xs text-muted">
              In any chat, <code className="font-mono">{commands.prefix}newsalerts here</code> adds that chat and <code className="font-mono">{commands.prefix}jid</code> shows its ID. A channel works too, if the linked account is one of its admins.
            </p>
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
            <p className="text-sm text-muted">
              {status?.lastError ? (
                <span className="text-danger">{status.lastError}</span>
              ) : status?.lastStory ? (
                <>
                  Last alert {relativeTime(status.lastStory.at)}: {status.lastStory.title.slice(0, 90)}
                </>
              ) : status?.lastCheckAt ? (
                <>Checked {relativeTime(status.lastCheckAt)}. Nothing new since alerts were switched on.</>
              ) : (
                'Send the latest story now to see what an alert looks like.'
              )}
            </p>
            <Button busy={testing} disabled={!connected || news.chats.length === 0} onClick={sendTest} icon={<Send className="h-4 w-4" />}>
              Send the latest story now
            </Button>
          </div>
          {!connected && (
            <div className="mt-3">
              <Notice tone="warn">WhatsApp is not connected, so nothing can be sent right now. Stories published meanwhile are sent when the connection is back.</Notice>
            </div>
          )}
        </Card>

        <Card title="Language" description={`Used by alerts and by ${commands.prefix}news. One request can ask for another: ${commands.prefix}news en.`}>
          <Segmented
            label="Language"
            value={news.language}
            onChange={language => save({ language })}
            options={[
              { value: 'si', label: 'සිංහල' },
              { value: 'en', label: 'English' },
              { value: 'both', label: 'Both' }
            ]}
          />
          <p className="mt-2 text-xs text-muted">{news.language === 'both' ? 'Headlines in Sinhala with the English under them; the story itself in Sinhala.' : 'Headlines and stories in this language.'}</p>
        </Card>

        <Card title="What alerts include" description="Applies to alerts only; the news command always shows everything.">
          <div>
            <p className="mb-2 text-sm font-medium">Topics</p>
            <div className="flex flex-wrap gap-2">
              {TOPICS.map(topic => {
                const active = news.categories.length === 0 || news.categories.includes(topic.id);
                return (
                  <button
                    key={topic.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => toggleTopic(topic.id)}
                    className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${active ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted hover:text-ink'}`}
                  >
                    {topic.label}
                  </button>
                );
              })}
            </div>
            <p className="mt-2 text-xs text-muted">{news.categories.length === 0 ? 'Everything is sent. Click a topic to send only that one.' : 'Only the highlighted topics are sent. Highlight none to send everything again.'}</p>
          </div>
          <div className="mt-2 border-t border-line pt-2">
            <Toggle label="Pictures" description="Each alert carries the story's picture." checked={news.images} onChange={images => save({ images })} />
            <Toggle label="Voice recordings" description="Stories that are a recorded statement arrive with the audio, ready to play." checked={news.voiceClips} onChange={voiceClips => save({ voiceClips })} />
          </div>
        </Card>

        <Card title="Timing" description="Times are Sri Lanka time, whatever clock the server runs on.">
          <Toggle
            label="Quiet hours"
            description="No alerts between these times. When they end, one message lists what was published meanwhile; replying with a number opens a story."
            checked={news.quietHours}
            onChange={quietHours => save({ quietHours })}
          />
          {news.quietHours && (
            <div className="grid max-w-md grid-cols-2 gap-4 py-2">
              <Field label="From">
                <CommitInput type="time" value={news.quietFrom} onCommit={quietFrom => void (/^\d{2}:\d{2}$/.test(quietFrom) && save({ quietFrom }))} />
              </Field>
              <Field label="Until">
                <CommitInput type="time" value={news.quietTo} onCommit={quietTo => void (/^\d{2}:\d{2}$/.test(quietTo) && save({ quietTo }))} />
              </Field>
            </div>
          )}
          <div className="mt-2 max-w-xs border-t border-line pt-4">
            <Field label="Check for news every" hint="Seconds, from 30 to 3600. A minute is quick enough and gentle on the news service.">
              <CommitInput
                type="number"
                min={30}
                max={3600}
                step={10}
                value={news.intervalSeconds}
                onCommit={value => save({ intervalSeconds: Math.min(3600, Math.max(30, Math.round(Number(value)) || 60)) })}
              />
            </Field>
          </div>
        </Card>

        <Card title="Commands" description="What people can type in a chat.">
          <ul className="space-y-2 text-sm">
            {[
              [`${commands.prefix}news`, 'The ten latest stories. Reply with a number to read one in full.'],
              [`${commands.prefix}news top`, 'The top stories of the moment.'],
              [`${commands.prefix}news incidents`, 'One topic: incidents, statements, notices or voice.'],
              [`${commands.prefix}news fuel prices`, 'Search the stories of the last few days.'],
              [`${commands.prefix}news en`, 'Any of the above in English (si for Sinhala, both for both).'],
              [`${commands.prefix}worldnews`, 'International headlines in English, from Google News.'],
              [`${commands.prefix}newsalerts`, 'For owners: on, off, here, remove, test.']
            ].map(([command, meaning]) => (
              <li key={command} className="flex flex-wrap gap-x-3">
                <code className="font-mono text-accent">{command}</code>
                <span className="text-muted">{meaning}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
