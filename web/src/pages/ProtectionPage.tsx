import { useEffect, useState } from 'react';
import { Card, CommitInput, CommitTextarea, Field, Notice, PageHeader, SaveIndicator, Select, Spinner, Toggle } from '../components/ui';
import { api } from '../lib/api';
import { useLive } from '../lib/live';
import type { TargetList } from '../lib/types';

const CUSTOM = '__custom__';

/** Clamp a typed number into the range the server accepts. */
function bounded(value: string, min: number, max: number): number {
  const parsed = Math.round(Number(value));
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : min;
}

export function ProtectionPage() {
  const { settings, saveSettings, saveState, saveError, directoryVersion } = useLive();
  const [targets, setTargets] = useState<TargetList>({ groups: [], contacts: [] });
  const [customAlert, setCustomAlert] = useState(false);

  useEffect(() => {
    api<TargetList>('/targets').then(setTargets).catch(() => {});
  }, [directoryVersion]);

  if (!settings) {
    return (
      <div className="flex items-center gap-3 text-muted">
        <Spinner /> Loading…
      </div>
    );
  }

  const { antiDelete, viewOnce, status, calls, general, commands } = settings;
  const knownGroup = targets.groups.some(group => group.jid === general.alertTarget);
  const alertChoice = customAlert ? CUSTOM : general.alertTarget === 'owner' ? 'owner' : knownGroup ? general.alertTarget : CUSTOM;

  return (
    <>
      <PageHeader
        title="Protection"
        description="Catch what would otherwise disappear: deleted messages, edits, view-once media, statuses and unwanted calls."
        actions={<SaveIndicator state={saveState} error={saveError} />}
      />

      <div className="space-y-6">
        <Card title="Where alerts go" description="Recovered messages, revealed media and forwarded statuses are delivered to this chat.">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Alert chat">
              <Select
                value={alertChoice}
                onChange={event => {
                  const value = event.target.value;
                  setCustomAlert(value === CUSTOM);
                  if (value !== CUSTOM) void saveSettings('general', { alertTarget: value });
                }}
              >
                <option value="owner">My own chat ("Message yourself")</option>
                {targets.groups.map(group => (
                  <option key={group.jid} value={group.jid}>
                    Group: {group.name}
                  </option>
                ))}
                <option value={CUSTOM}>Another chat ID…</option>
              </Select>
            </Field>
            {alertChoice === CUSTOM && (
              <Field label="Chat ID" hint={`Send ${commands.prefix}jid in any chat to see its ID.`}>
                <CommitInput
                  placeholder="15551234567@s.whatsapp.net"
                  value={general.alertTarget === 'owner' ? '' : general.alertTarget}
                  onCommit={value => value.trim() && saveSettings('general', { alertTarget: value.trim() })}
                />
              </Field>
            )}
          </div>
        </Card>

        <Card
          title="Anti-delete"
          description="Keeps a short-lived copy of incoming messages. When someone deletes a message for everyone, the original is sent to your alert chat."
        >
          <Toggle label="Recover deleted messages" checked={antiDelete.enabled} onChange={enabled => saveSettings('antiDelete', { enabled })} />
          {antiDelete.enabled && (
            <div className="mt-2 space-y-1 border-t border-line pt-3">
              <Toggle label="In private chats" checked={antiDelete.privateChats} onChange={privateChats => saveSettings('antiDelete', { privateChats })} />
              <Toggle label="In groups" checked={antiDelete.groups} onChange={groups => saveSettings('antiDelete', { groups })} />
              <Toggle
                label="Report edited messages too"
                description="Shows the text before and after someone edits a message."
                checked={antiDelete.edits}
                onChange={edits => saveSettings('antiDelete', { edits })}
              />
              <Toggle
                label="Keep photos, videos and voice notes"
                description="Media is downloaded as it arrives so it can still be recovered after deletion."
                checked={antiDelete.cacheMedia}
                onChange={cacheMedia => saveSettings('antiDelete', { cacheMedia })}
              />
              <div className="grid gap-4 pt-3 md:grid-cols-2">
                <Field label="Keep messages for (hours)" hint="Between 1 and 48. Older copies are erased automatically.">
                  <CommitInput type="number" min={1} max={48} value={antiDelete.ttlHours} onCommit={value => saveSettings('antiDelete', { ttlHours: bounded(value, 1, 48) })} />
                </Field>
                <Field label="Largest file to keep (MB)">
                  <CommitInput
                    type="number"
                    min={1}
                    max={100}
                    disabled={!antiDelete.cacheMedia}
                    value={antiDelete.maxMediaMb}
                    onCommit={value => saveSettings('antiDelete', { maxMediaMb: bounded(value, 1, 100) })}
                  />
                </Field>
              </div>
            </div>
          )}
        </Card>

        <Card title="Anti view-once" description="Saves view-once photos, videos and voice notes as normal media.">
          <Toggle label="Reveal view-once media" checked={viewOnce.enabled} onChange={enabled => saveSettings('viewOnce', { enabled })} />
          {viewOnce.enabled && (
            <div className="mt-2 space-y-3 border-t border-line pt-4">
              <Notice>
                <p className="font-medium">How to reveal one</p>
                <p className="mt-1">
                  WhatsApp only delivers view-once media to your phone, never to linked devices like this bot. So when one arrives,{' '}
                  <strong>reply to it from your phone</strong> (any text, even a dot). WhatsApp attaches the original to the reply, which is
                  what lets the bot save a copy to the destination below.
                </p>
              </Notice>
              <Toggle
                label="Reveal when the message is replied to"
                description={`Works for your own replies and anyone else's. When off, reply with ${commands.prefix}vv instead.`}
                checked={viewOnce.onReply}
                onChange={onReply => saveSettings('viewOnce', { onReply })}
              />
              <Toggle
                label="Tell me when a view-once arrives"
                description="Sends a reminder to the alert chat so you know there is something to reply to."
                checked={viewOnce.notify}
                onChange={notify => saveSettings('viewOnce', { notify })}
              />
              <div className="max-w-md pt-1">
                <Field label="Send the revealed media to">
                  <Select value={viewOnce.destination} onChange={event => saveSettings('viewOnce', { destination: event.target.value as 'alert' | 'chat' })}>
                    <option value="alert">My alert chat (private)</option>
                    <option value="chat">The chat it was sent in (everyone there sees it)</option>
                  </Select>
                </Field>
              </div>
            </div>
          )}
        </Card>

        <Card title="Status updates" description="What to do when your contacts post a status (story).">
          <Toggle
            label="View statuses automatically"
            description="Contacts will see that you viewed their status."
            checked={status.autoView}
            onChange={autoView => saveSettings('status', { autoView })}
          />
          <Toggle
            label="Forward statuses to the alert chat"
            description={`Downloads each new status and sends you a copy. To keep just one, reply to it with ${commands.prefix}save.`}
            checked={status.forward}
            onChange={forward => saveSettings('status', { forward })}
          />
        </Card>

        <Card title="Calls" description="WhatsApp does not let a linked device pick up a call, so the bot declines it and answers in the chat instead.">
          <Toggle label="Decline incoming calls" checked={calls.reject} onChange={reject => saveSettings('calls', { reject })} />
          {calls.reject && (
            <div className="mt-2 grid gap-4 border-t border-line pt-4">
              <Field label="Message to the caller" hint="Sent right after declining. Leave empty to decline silently.">
                <CommitTextarea rows={2} value={calls.message} onCommit={message => saveSettings('calls', { message })} />
              </Field>
              <Toggle
                label="Answer the caller with a voice note"
                description="Speaks the message below instead of sending the text. Uses the assistant's voice when a Gemini key is set, a basic voice otherwise. With the AI assistant on, the caller can then carry on by voice note."
                checked={calls.voiceGreeting}
                onChange={voiceGreeting => saveSettings('calls', { voiceGreeting })}
              />
              {calls.voiceGreeting && (
                <Field label="What the voice note says" hint="Plain sentences work best. Up to 600 characters.">
                  <CommitTextarea rows={3} maxLength={600} value={calls.voiceMessage} onCommit={voiceMessage => void (voiceMessage.trim() && saveSettings('calls', { voiceMessage }))} />
                </Field>
              )}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
