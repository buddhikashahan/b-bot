import { Globe, Lock, MessageCircle, Plus, Users } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { ChatSearch } from '../components/shared';
import { Button, Card, Chips, Input, PageHeader, SaveIndicator, Segmented, Spinner, Toggle } from '../components/ui';
import { api } from '../lib/api';
import { useLive } from '../lib/live';
import type { ChatScope, TargetList } from '../lib/types';

const MODE_HELP = {
  public: 'Anyone who messages the bot can use commands.',
  private: 'Only you and the owners listed below can use commands. Everyone else is ignored silently.'
};
const SCOPE_HELP: Record<ChatScope, string> = {
  all: 'Commands work in private chats and in groups.',
  groups: 'Commands work in groups only. Private messages to the bot are ignored.',
  private: 'Commands work in private chats only. The bot stays quiet in groups.'
};

/** Small "type a phone number and add it" form. */
function AddNumber({ onAdd, label }: { onAdd: (phone: string) => void; label: string }) {
  const [value, setValue] = useState('');
  const digits = value.replace(/\D/g, '');
  // WhatsApp knows people by their full international number: "0771234567" would never match anyone.
  const local = digits.startsWith('0');
  const valid = digits.length >= 6 && digits.length <= 16 && !local;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    onAdd(digits);
    setValue('');
  };
  return (
    <form onSubmit={submit}>
      <div className="flex gap-2">
        <Input aria-label={label} inputMode="numeric" placeholder="Number with country code, e.g. 15551234567" value={value} onChange={event => setValue(event.target.value)} />
        <Button type="submit" disabled={!valid} icon={<Plus className="h-4 w-4" />}>
          Add
        </Button>
      </div>
      {local && <p className="mt-1.5 text-xs text-muted">Start with the country code instead of 0, for example 94771234567.</p>}
    </form>
  );
}

export function AccessPage() {
  const { settings, saveSettings, saveState, saveError, session, directoryVersion } = useLive();
  const [targets, setTargets] = useState<TargetList>({ groups: [], contacts: [] });

  useEffect(() => {
    api<TargetList>('/targets').then(setTargets).catch(() => {});
  }, [directoryVersion, session?.status]);

  const contactNames = useMemo(() => new Map(targets.contacts.map(contact => [contact.jid.split('@')[0], contact.name])), [targets]);
  const groupNames = useMemo(() => new Map(targets.groups.map(group => [group.jid, group.name])), [targets]);

  if (!settings) {
    return (
      <div className="flex items-center gap-3 text-muted">
        <Spinner /> Loading…
      </div>
    );
  }

  const { commands, general, access, adult } = settings;
  const personLabel = (phone: string) => (contactNames.has(phone) ? `${contactNames.get(phone)} (+${phone})` : `+${phone}`);
  const contactItems = targets.contacts.map(contact => ({ jid: contact.jid, name: contact.name, detail: `+${contact.jid.split('@')[0]}` }));

  const addOwner = (phone: string) => !general.ownerNumbers.includes(phone) && saveSettings('general', { ownerNumbers: [...general.ownerNumbers, phone] });
  const approveAdult = (phone: string) => !adult.verified.includes(phone) && saveSettings('adult', { verified: [...adult.verified, phone] });
  const blockUser = (phone: string) => !access.blockedUsers.includes(phone) && saveSettings('access', { blockedUsers: [...access.blockedUsers, phone] });
  const blockGroup = (jid: string) => !access.blockedChats.includes(jid) && saveSettings('access', { blockedChats: [...access.blockedChats, jid] });

  return (
    <>
      <PageHeader
        title="Access"
        description="Decide who the bot listens to, where it responds, and who it ignores."
        actions={<SaveIndicator state={saveState} error={saveError} />}
      />

      <div className="space-y-6">
        <Card title="Who can use the bot">
          <Segmented
            label="Bot mode"
            value={commands.mode}
            onChange={mode => saveSettings('commands', { mode })}
            options={[
              { value: 'public', label: 'Public', icon: <Globe className="h-4 w-4" /> },
              { value: 'private', label: 'Private', icon: <Lock className="h-4 w-4" /> }
            ]}
          />
          <p className="mt-3 text-sm text-muted">{MODE_HELP[commands.mode]}</p>
        </Card>

        <Card title="Where commands work" description="Owners can always use commands anywhere, whatever is chosen here.">
          <Segmented
            label="Command scope"
            value={commands.scope}
            onChange={scope => saveSettings('commands', { scope })}
            options={[
              { value: 'all', label: 'Everywhere' },
              { value: 'groups', label: 'Groups only', icon: <Users className="h-4 w-4" /> },
              { value: 'private', label: 'Private chats only', icon: <MessageCircle className="h-4 w-4" /> }
            ]}
          />
          <p className="mt-3 text-sm text-muted">{SCOPE_HELP[commands.scope]}</p>
        </Card>

        <Card title="Owners" description="Owners can use every command, including the ones that change settings. The linked WhatsApp account is always an owner.">
          <div className="space-y-4">
            <Chips
              empty="No extra owners. Only the linked account controls the bot."
              items={general.ownerNumbers.map(phone => ({ key: phone, label: personLabel(phone) }))}
              onRemove={phone => saveSettings('general', { ownerNumbers: general.ownerNumbers.filter(item => item !== phone) })}
            />
            <div className="grid gap-3 md:grid-cols-2">
              <ChatSearch items={contactItems} exclude={general.ownerNumbers.map(phone => `${phone}@s.whatsapp.net`)} placeholder="Search your contacts" onPick={jid => addOwner(jid.split('@')[0])} />
              <AddNumber label="Owner phone number" onAdd={addOwner} />
            </div>
          </div>
        </Card>

        <Card
          title="18+ commands"
          description={`Adult search and downloads (${commands.prefix}phsearch, ${commands.prefix}phdl), only for people confirmed as adults. They work in private chats, and the search also in groups you allow below; a download is always sent privately.`}
        >
          <Toggle
            label="Allow 18+ commands"
            description={`From WhatsApp: ${commands.prefix}adult on and ${commands.prefix}adult off. Sharing adult material breaks WhatsApp's terms and is against the law in some countries, Sri Lanka among them: this is your decision and your risk.`}
            checked={adult.enabled}
            onChange={enabled => saveSettings('adult', { enabled })}
          />
          {adult.enabled && (
            <div className="mt-2 space-y-4 border-t border-line pt-4">
              <div>
                <p className="mb-2 text-sm font-medium">Confirmed adults</p>
                <Chips
                  empty="Nobody yet. Owners are always allowed."
                  items={adult.verified.map(phone => ({ key: phone, label: personLabel(phone) }))}
                  onRemove={phone => saveSettings('adult', { verified: adult.verified.filter(item => item !== phone) })}
                />
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <ChatSearch items={contactItems} exclude={adult.verified.map(phone => `${phone}@s.whatsapp.net`)} placeholder="Search your contacts" onPick={jid => approveAdult(jid.split('@')[0])} />
                <AddNumber label="Number to approve" onAdd={approveAdult} />
              </div>
              <div className="border-t border-line pt-4">
                <p className="mb-2 text-sm font-medium">Groups where the search is allowed</p>
                <Chips
                  empty="None. The 18+ commands work in private chats only."
                  items={adult.groups.map(jid => ({ key: jid, label: groupNames.get(jid) ?? jid }))}
                  onRemove={jid => saveSettings('adult', { groups: adult.groups.filter(item => item !== jid) })}
                />
                <div className="mt-3 max-w-md">
                  <ChatSearch
                    items={targets.groups.map(group => ({ jid: group.jid, name: group.name, detail: `${group.size} members` }))}
                    exclude={adult.groups}
                    placeholder={targets.groups.length ? 'Search your groups' : 'Connect WhatsApp to list your groups'}
                    onPick={jid => !adult.groups.includes(jid) && saveSettings('adult', { groups: [...adult.groups, jid] })}
                  />
                </div>
                <p className="mt-2 text-xs text-muted">
                  Everyone in such a group sees the search results (video titles, no pictures), so allow it only where every member is an adult who expects it. Whatever someone downloads goes to their private chat, never
                  into the group. From WhatsApp: <code className="font-mono">{commands.prefix}adult group on</code> inside the group.
                </p>
              </div>
              <p className="text-xs text-muted">
                People can also confirm their own age with <code className="font-mono">{commands.prefix}verify</code>: they send a photo of an ID card, passport or driving licence, the AI reads the date of birth, and
                the photo is not kept. That check reads a date; it cannot tell whether the document is genuine or belongs to the sender, so add people you know here yourself when it matters.
              </p>
            </div>
          )}
        </Card>

        <Card
          title="Blocked people"
          description={`The bot never answers these numbers: no commands, no auto-replies. Their deleted messages are still recovered. From WhatsApp: ${commands.prefix}block and ${commands.prefix}unblock.`}
        >
          <div className="space-y-4">
            <Chips
              empty="Nobody is blocked."
              items={access.blockedUsers.map(phone => ({ key: phone, label: personLabel(phone) }))}
              onRemove={phone => saveSettings('access', { blockedUsers: access.blockedUsers.filter(item => item !== phone) })}
            />
            <div className="grid gap-3 md:grid-cols-2">
              <ChatSearch items={contactItems} exclude={access.blockedUsers.map(phone => `${phone}@s.whatsapp.net`)} placeholder="Search your contacts" onPick={jid => blockUser(jid.split('@')[0])} />
              <AddNumber label="Phone number to block" onAdd={blockUser} />
            </div>
          </div>
        </Card>

        <Card
          title="Ignored groups"
          description={`The bot is completely inactive in these groups: no commands, no link filtering, no greetings, nothing recorded. From WhatsApp: ${commands.prefix}ignore on inside the group.`}
        >
          <div className="space-y-4">
            <Chips
              empty="The bot is active in every group."
              items={access.blockedChats.map(jid => ({ key: jid, label: groupNames.get(jid) ?? jid }))}
              onRemove={jid => saveSettings('access', { blockedChats: access.blockedChats.filter(item => item !== jid) })}
            />
            <div className="max-w-md">
              <ChatSearch
                items={targets.groups.map(group => ({ jid: group.jid, name: group.name, detail: `${group.size} members` }))}
                exclude={access.blockedChats}
                placeholder={targets.groups.length ? 'Search your groups' : 'Connect WhatsApp to list your groups'}
                onPick={blockGroup}
              />
            </div>
          </div>
        </Card>
      </div>
    </>
  );
}
