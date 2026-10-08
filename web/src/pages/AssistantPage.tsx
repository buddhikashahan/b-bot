import { ExternalLink, KeyRound, Send, Sparkles, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { WhatsAppText } from '../components/shared';
import { Badge, Button, Card, CommitInput, CommitTextarea, Field, Input, Notice, PageHeader, SaveIndicator, Segmented, Select, Spinner, Toggle, cx, useToast } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { useLive } from '../lib/live';
import type { AiStatus, ChatScope } from '../lib/types';

/** Gemini's speech voices (the same list as VOICES in server/src/features/ai.ts). */
const VOICES = ['Kore', 'Puck', 'Charon', 'Aoede', 'Fenrir', 'Leda', 'Orus', 'Zephyr'];

/** Ready-made instructions people can start from. */
const PERSONALITIES: { name: string; prompt: string }[] = [
  {
    name: 'Friendly helper',
    prompt: ''
  },
  {
    name: 'Business assistant',
    prompt:
      'You are the assistant of a small business, answering customers on WhatsApp. Be polite, clear and brief. ' +
      'Answer questions about products, prices and opening hours using only the facts written below. ' +
      'If you are not sure, say that a member of staff will reply soon. Never invent prices or promises.\n\n' +
      'Facts about the business:\n- Name: \n- Opening hours: \n- Address: \n- Products and prices: '
  },
  {
    name: 'Short and direct',
    prompt: 'Answer in one or two short sentences. No greetings, no emojis, no filler. If a question needs a long answer, give the key point and offer to explain more.'
  },
  {
    name: 'Personal stand-in',
    prompt:
      'You answer messages for me while I am busy. Speak casually, like a friend would, and keep it short. ' +
      'Let people know I will get back to them myself for anything important. Do not make plans or promises on my behalf.'
  }
];

function Step({ number, title, children, done }: { number: number; title: string; children: ReactNode; done?: boolean }) {
  return (
    <section className="rounded-xl border border-line bg-panel">
      <div className="flex items-center gap-3 border-b border-line px-5 py-4">
        <span className={cx('flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold', done ? 'bg-accent text-on-accent' : 'bg-raised text-muted')}>
          {number}
        </span>
        <h2 className="font-semibold">{title}</h2>
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

export function AssistantPage() {
  const { settings, saveSettings, saveState, saveError } = useLive();
  const toast = useToast();
  const [status, setStatus] = useState<AiStatus>();
  const [models, setModels] = useState<string[]>([]);
  const [key, setKey] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<{ reply: string; model: string; seconds: number }>();

  const load = useCallback(() => {
    api<AiStatus>('/ai').then(setStatus).catch(() => {});
    api<string[]>('/ai/models').then(setModels).catch(() => {});
  }, []);
  useEffect(load, [load]);

  if (!settings || !status) {
    return (
      <div className="flex items-center gap-3 text-muted">
        <Spinner /> Loading…
      </div>
    );
  }

  const { ai } = settings;
  const ready = status.configured;

  const saveKey = async (event: FormEvent) => {
    event.preventDefault();
    setBusy('key');
    try {
      const saved = await api<AiStatus & { models: string[]; modelAvailable: boolean }>('/ai/key', { method: 'PUT', body: { key: key.trim() } });
      setStatus(saved);
      setModels(saved.models);
      setKey('');
      setReplacing(false);
      toast(saved.modelAvailable ? 'Key accepted by Google. The assistant is ready to switch on.' : 'Key accepted, but it cannot use the selected model. Pick another one in step 4.', saved.modelAvailable ? 'good' : 'danger');
    } catch (error) {
      toast(errorMessage(error), 'danger');
    } finally {
      setBusy(undefined);
    }
  };

  const removeKey = async () => {
    setBusy('remove');
    try {
      setStatus(await api<AiStatus>('/ai/key', { method: 'DELETE' }));
      setModels([]);
      toast('Key removed. The assistant is off.');
    } catch (error) {
      toast(errorMessage(error), 'danger');
    } finally {
      setBusy(undefined);
      setConfirmRemove(false);
    }
  };

  const tryIt = async (event: FormEvent) => {
    event.preventDefault();
    setBusy('try');
    setAnswer(undefined);
    try {
      setAnswer(await api<{ reply: string; model: string; seconds: number }>('/ai/test', { body: { message: question } }));
      api<AiStatus>('/ai').then(setStatus).catch(() => {});
    } catch (error) {
      toast(errorMessage(error), 'danger');
    } finally {
      setBusy(undefined);
    }
  };

  const forget = async () => {
    setBusy('forget');
    try {
      const { removed } = await api<{ removed: number }>('/ai/memory', { method: 'DELETE' });
      toast(removed ? 'The assistant has forgotten every conversation.' : 'There was nothing to forget.');
    } catch (error) {
      toast(errorMessage(error), 'danger');
    } finally {
      setBusy(undefined);
    }
  };

  const activePersonality = PERSONALITIES.find(item => item.prompt === ai.prompt)?.name ?? 'Custom';
  const groupsInScope = ai.scope !== 'private';
  const modelChoices = models.includes(ai.model) ? models : [ai.model, ...models];
  const modelMissing = ready && models.length > 0 && !models.includes(ai.model);

  return (
    <>
      <PageHeader
        title="AI assistant"
        description="Let Google Gemini answer ordinary messages for you. Commands, menus and keyword replies still come first."
        actions={<SaveIndicator state={saveState} error={saveError} />}
      />

      <div className="space-y-6">
        <Step number={1} title="Connect Google Gemini" done={ready}>
          {ready && !replacing ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-3">
                <Badge tone="good">Connected</Badge>
                <span className="text-sm text-muted">
                  Using the key ending in <code className="font-mono">{status.keyHint}</code>. It is stored on your server and never shown again.
                </span>
              </div>
              <div className="flex gap-2">
                <Button size="sm" onClick={() => setReplacing(true)} icon={<KeyRound className="h-3.5 w-3.5" />}>
                  Replace key
                </Button>
                {confirmRemove ? (
                  <Button size="sm" variant="danger" busy={busy === 'remove'} onClick={removeKey}>
                    Yes, remove it
                  </Button>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(true)} icon={<Trash2 className="h-3.5 w-3.5" />}>
                    Remove
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <div className="grid gap-6 md:grid-cols-2">
              <ol className="space-y-2 text-sm">
                {[
                  <>
                    Open{' '}
                    <a className="inline-flex items-center gap-1 font-medium text-accent hover:underline" href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">
                      Google AI Studio <ExternalLink className="h-3 w-3" />
                    </a>{' '}
                    and sign in with a Google account.
                  </>,
                  <>Press "Create API key" and copy the key it gives you.</>,
                  <>Paste it here. It is checked with Google before it is saved.</>
                ].map((text, index) => (
                  <li key={index} className="flex gap-3">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent">{index + 1}</span>
                    <span className="pt-0.5">{text}</span>
                  </li>
                ))}
                <li className="pt-2 text-xs text-muted">Google offers a free tier with daily limits; heavier use is billed by Google to that account.</li>
              </ol>
              <form onSubmit={saveKey} className="space-y-3">
                <Field label="Gemini API key">
                  <Input type="password" autoComplete="off" spellCheck={false} placeholder="Paste your key" value={key} onChange={event => setKey(event.target.value)} required minLength={10} />
                </Field>
                <div className="flex gap-2">
                  <Button type="submit" variant="primary" busy={busy === 'key'} disabled={key.trim().length < 10} icon={<KeyRound className="h-4 w-4" />}>
                    {busy === 'key' ? 'Checking…' : 'Save key'}
                  </Button>
                  {replacing && (
                    <Button variant="ghost" onClick={() => setReplacing(false)}>
                      Cancel
                    </Button>
                  )}
                </div>
              </form>
            </div>
          )}
          {status.notice && (
            <div className="mt-4">
              <Notice>{status.notice} Nothing is wrong on your side; Google's newest models are often at capacity.</Notice>
            </div>
          )}
          {status.lastError && (
            <div className="mt-4">
              <Notice tone="warn">
                Last problem ({new Date(status.lastError.at).toLocaleTimeString()}): {status.lastError.message}
              </Notice>
            </div>
          )}
        </Step>

        <Step number={2} title="Switch it on" done={ready && ai.enabled}>
          <Toggle
            label="Answer messages automatically"
            description={ready ? 'Replies to messages that are not commands. People you have blocked and groups you ignore never get an answer.' : 'Add an API key in step 1 first.'}
            checked={ai.enabled && ready}
            disabled={!ready}
            onChange={enabled => saveSettings('ai', { enabled })}
          />
          <div className="mt-3 space-y-4 border-t border-line pt-4">
            <div>
              <p className="mb-2 text-sm font-medium">Where should it answer?</p>
              <Segmented<ChatScope>
                label="Where the assistant answers"
                value={ai.scope}
                onChange={scope => saveSettings('ai', { scope })}
                options={[
                  { value: 'private', label: 'Private chats' },
                  { value: 'groups', label: 'Groups' },
                  { value: 'all', label: 'Both' }
                ]}
              />
            </div>
            {groupsInScope && (
              <div>
                <p className="mb-2 text-sm font-medium">In groups, answer…</p>
                <Segmented
                  label="Group behaviour"
                  value={ai.groupTrigger}
                  onChange={groupTrigger => saveSettings('ai', { groupTrigger })}
                  options={[
                    { value: 'mention', label: 'Only when mentioned or replied to' },
                    { value: 'always', label: 'Every message' }
                  ]}
                />
                {ai.groupTrigger === 'always' && (
                  <div className="mt-3">
                    <Notice tone="warn">Answering every message in a busy group gets noisy fast and uses up your quota. Most people prefer "only when mentioned".</Notice>
                  </div>
                )}
              </div>
            )}
          </div>
        </Step>

        <Step number={3} title="Give it a personality" done={ai.prompt.trim() !== ''}>
          <p className="mb-3 text-sm text-muted">
            Tell the assistant who it is, what it knows and how it should talk. Start from an example and edit it, or write your own.
          </p>
          <div className="mb-3 flex flex-wrap gap-2">
            {PERSONALITIES.map(item => (
              <button
                key={item.name}
                type="button"
                aria-pressed={activePersonality === item.name}
                onClick={() => saveSettings('ai', { prompt: item.prompt })}
                className={cx(
                  'rounded-full border px-3 py-1 text-sm transition-colors',
                  activePersonality === item.name ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-panel text-muted hover:text-ink'
                )}
              >
                {item.name}
              </button>
            ))}
            {activePersonality === 'Custom' && <span className="rounded-full border border-accent bg-accent-soft px-3 py-1 text-sm text-accent">Custom</span>}
          </div>
          <Field label="Instructions" hint="Saved when you click away. Leave empty for a friendly general helper. The assistant always answers in the language people write in.">
            <CommitTextarea
              rows={8}
              maxLength={6000}
              placeholder="Example: You are Maya, the assistant of Sunrise Bakery. We open 7am to 6pm every day. A loaf costs Rs. 250…"
              value={ai.prompt}
              onCommit={prompt => saveSettings('ai', { prompt })}
            />
          </Field>
        </Step>

        <Step number={4} title="Memory, photos and model">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Messages remembered per chat" hint="The assistant re-reads this many of the latest messages so it can follow the conversation. 0 means every message is answered on its own.">
              <CommitInput
                type="number"
                min={0}
                max={40}
                value={ai.historyMessages}
                onCommit={value => saveSettings('ai', { historyMessages: Math.min(40, Math.max(0, Math.round(Number(value)) || 0)) })}
              />
            </Field>
            <Field label="Model" hint="gemini-3.5-flash is a good balance of quality and speed. The -lite models answer fastest and cost least.">
              <Select value={ai.model} onChange={event => saveSettings('ai', { model: event.target.value })}>
                {modelChoices.map(model => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="mt-4 max-w-md">
            <Field label="Backup model" hint="Used automatically when the main model is overloaded or too slow at Google, so people still get an answer.">
              <Select value={ai.fallbackModel} onChange={event => saveSettings('ai', { fallbackModel: event.target.value })}>
                <option value="">No backup (wait for the main model)</option>
                {(models.includes(ai.fallbackModel) || !ai.fallbackModel ? models : [ai.fallbackModel, ...models])
                  .filter(model => model !== ai.model)
                  .map(model => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
              </Select>
            </Field>
          </div>
          {modelMissing && (
            <div className="mt-3">
              <Notice tone="warn">Your key cannot use "{ai.model}". Choose one of the other models in the list.</Notice>
            </div>
          )}
          <div className="mt-4">
            <p className="mb-2 text-sm font-medium">Answer speed</p>
            <Segmented
              label="Answer speed"
              value={ai.thinking}
              onChange={thinking => saveSettings('ai', { thinking })}
              options={[
                { value: 'low', label: 'Fast' },
                { value: 'medium', label: 'Balanced' },
                { value: 'high', label: 'Thorough' }
              ]}
            />
            <p className="mt-2 text-xs text-muted">
              {ai.thinking === 'low'
                ? 'Answers within a few seconds. Best for chatting.'
                : ai.thinking === 'medium'
                  ? 'The model thinks longer before answering. Replies can take noticeably longer.'
                  : 'The model reasons at length first. Good for hard questions, but people may wait a long time for a reply.'}
            </p>
          </div>
          <div className="mt-2">
            <Toggle
              label="Look at photos"
              description="When someone sends a picture, the assistant can describe it or answer questions about it."
              checked={ai.images}
              onChange={images => saveSettings('ai', { images })}
            />
            <Toggle
              label="Download songs and videos on request"
              description={`Ask it for a song or a video, or just send a YouTube, TikTok or Facebook link, and it sends the file without asking which format. Also works with ${settings.commands.prefix}ai. Only for people who may use the download commands themselves.`}
              checked={ai.downloads}
              onChange={downloads => saveSettings('ai', { downloads })}
            />
            <Toggle
              label="Listen to voice notes"
              description="When someone sends a voice note, the assistant listens to it and answers what was said."
              checked={ai.voiceNotes}
              onChange={voiceNotes => saveSettings('ai', { voiceNotes })}
            />
            {ai.voiceNotes && (
              <>
                <Toggle
                  label="Answer voice notes by voice"
                  description="Replies with a voice note in the same language. Switch off to answer voice notes in text."
                  checked={ai.voiceReplies}
                  onChange={voiceReplies => saveSettings('ai', { voiceReplies })}
                />
                {ai.voiceReplies && (
                  <div className="py-2">
                    <p className="mb-2 text-sm font-medium">Voice</p>
                    <Segmented label="Voice" value={ai.voice} onChange={voice => saveSettings('ai', { voice })} options={VOICES.map(voice => ({ value: voice, label: voice }))} />
                    <p className="mt-2 text-xs text-muted">
                      Also used for the voice note callers get (Protection page) and by <code className="font-mono">{settings.commands.prefix}tts</code>.
                    </p>
                  </div>
                )}
              </>
            )}
          </div>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
            <p className="text-sm text-muted">
              Conversations older than a day are not used, and are erased after a week. Anyone can send <code className="font-mono">{settings.commands.prefix}resetai</code>{' '}
              to make it forget their chat.
            </p>
            <Button size="sm" busy={busy === 'forget'} onClick={forget}>
              Forget all conversations
            </Button>
          </div>
        </Step>

        <Card title="Try it" description="Ask something to see how the assistant answers with your current instructions. Nothing is sent on WhatsApp.">
          {ready ? (
            <>
              <form onSubmit={tryIt} className="flex gap-2">
                <Input aria-label="Test message" placeholder="What time do you open?" value={question} onChange={event => setQuestion(event.target.value)} required />
                <Button type="submit" variant="primary" busy={busy === 'try'} icon={<Send className="h-4 w-4" />}>
                  Ask
                </Button>
              </form>
              {answer && (
                <div className="mt-4 rounded-lg bg-raised p-3">
                  <div className="max-w-xl rounded-lg rounded-tl-none bg-accent-soft px-3 py-2 text-sm break-words whitespace-pre-wrap">
                    <WhatsAppText text={answer.reply} />
                  </div>
                  <p className="mt-2 text-xs text-muted">
                    Answered by <code className="font-mono">{answer.model}</code> in {answer.seconds}s
                    {answer.model !== ai.model && ' (the backup model, because the main one did not answer)'}
                  </p>
                </div>
              )}
            </>
          ) : (
            <p className="flex items-center gap-2 text-sm text-muted">
              <Sparkles className="h-4 w-4" /> Add an API key first, then you can test the assistant here.
            </p>
          )}
        </Card>
      </div>
    </>
  );
}
