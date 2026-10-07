import { ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';
import { PageHeader } from '../components/ui';
import { useLive } from '../lib/live';

function Topic({ question, children }: { question: string; children: ReactNode }) {
  return (
    <details className="group rounded-xl border border-line bg-panel">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4 font-medium">
        {question}
        <ChevronDown className="h-4 w-4 shrink-0 text-muted transition-transform group-open:rotate-180" aria-hidden />
      </summary>
      <div className="space-y-2 border-t border-line px-5 py-4 text-sm leading-relaxed text-muted">{children}</div>
    </details>
  );
}

function Go({ to, children }: { to: string; children: ReactNode }) {
  return (
    <a href={`#/${to}`} className="font-medium text-accent hover:underline">
      {children}
    </a>
  );
}

export function HelpPage() {
  const { settings } = useLive();
  const p = settings?.commands.prefix ?? '.';
  const Cmd = ({ children }: { children: string }) => (
    <code className="rounded bg-raised px-1 py-0.5 font-mono text-ink">
      {p}
      {children}
    </code>
  );

  return (
    <>
      <PageHeader title="Help" description="Short answers to the things people ask most. Click a question to open it." />

      <div className="space-y-6">
        <section className="space-y-3">
          <h2 className="font-semibold">Getting started</h2>
          <Topic question="How do I connect my WhatsApp?">
            <p>
              Open <Go to="connection">Connection</Go> and press "Generate QR code". On your phone open WhatsApp, go to Settings, then Linked devices, then Link a device, and
              scan the code. If you cannot scan, choose "Pairing code" and type the code into your phone instead.
            </p>
            <p>You only do this once. The bot reconnects by itself after restarts or internet drops.</p>
          </Topic>
          <Topic question="How do I use the bot from WhatsApp?">
            <p>
              Send <Cmd>menu</Cmd> to your own number (the "Message yourself" chat) or in any chat. The bot replies with a numbered list. <strong>Reply with a number</strong> to
              open a category, then again to run a command.
            </p>
            <p>
              Commands start with <code className="rounded bg-raised px-1 font-mono text-ink">{p}</code>. You can change that symbol on the <Go to="commands">Commands</Go> page.
            </p>
          </Topic>
          <Topic question="Where do recovered messages and alerts go?">
            <p>
              To your <strong>alert chat</strong>. By default that is your own "Message yourself" chat, so only you see them. You can pick a group instead on the{' '}
              <Go to="protection">Protection</Go> page.
            </p>
          </Topic>
        </section>

        <section className="space-y-3">
          <h2 className="font-semibold">Features</h2>
          <Topic question="How do I see deleted messages?">
            <p>
              Turn on "Anti-delete" on the <Go to="overview">Overview</Go> or <Go to="protection">Protection</Go> page. From then on, when someone deletes a message for everyone, the
              bot sends you the original. It cannot recover messages that were sent before you switched it on.
            </p>
          </Topic>
          <Topic question="How do I open a view-once photo or video?">
            <p>
              WhatsApp only sends view-once media to your phone, never to linked devices, so the bot cannot open it on its own. With "Anti view-once" on, the bot tells you when
              one arrives. Then <strong>reply to that view-once message from your phone</strong> with any text. The bot saves a normal copy to your alert chat.
            </p>
          </Topic>
          <Topic question="How do I set up the AI assistant?">
            <p>
              Open <Go to="assistant">AI assistant</Go> and follow the four steps: get a free key from Google, paste it, switch the assistant on, and tell it how to behave. It then
              answers ordinary messages by itself. Use the "Try it" box to test before going live.
            </p>
            <p>
              Anyone can also ask it directly with <Cmd>ai your question</Cmd>, even when automatic answers are off.
            </p>
          </Topic>
          <Topic question="What is the difference between auto-replies, menus and the AI?">
            <p>
              <Go to="replies">Auto-replies</Go> send one fixed answer when a message contains a word you choose. <Go to="menus">Menus</Go> send a numbered list and wait for the
              person to pick. The <Go to="assistant">AI assistant</Go> writes its own answer to anything.
            </p>
            <p>When more than one could answer, the order is: commands, then menus, then auto-replies, then the AI.</p>
          </Topic>
          <Topic question="How do I download a song or video?">
            <p>
              Send <Cmd>song name of the song</Cmd> or <Cmd>video name</Cmd>. For Facebook, TikTok, Instagram or X, send <Cmd>fb</Cmd>, <Cmd>tiktok</Cmd>, <Cmd>insta</Cmd> or{' '}
              <Cmd>x</Cmd> followed by the link. <Cmd>yts words</Cmd> searches YouTube; reply with a number to download a result.
            </p>
            <p>
              If downloads stop working, press "Update downloader" on the <Go to="commands">Commands</Go> page. Only download what you have the right to save.
            </p>
          </Topic>
          <Topic question="How do I schedule a message?">
            <p>
              Open <Go to="scheduler">Scheduler</Go>, press "New message", write it, choose who gets it and when. It can be sent once or on a repeating schedule, and it is sent
              even if the bot was restarted in between.
            </p>
          </Topic>
        </section>

        <section className="space-y-3">
          <h2 className="font-semibold">Control</h2>
          <Topic question="How do I stop strangers from using my bot?">
            <p>
              On the <Go to="access">Access</Go> page choose <strong>Private</strong>. Then only you (and any owners you add) can use commands. You can also limit commands to
              groups only or private chats only.
            </p>
          </Topic>
          <Topic question="How do I block a person or silence the bot in one group?">
            <p>
              On <Go to="access">Access</Go>, add the person under "Blocked people" or the group under "Ignored groups". From WhatsApp, reply to the person with <Cmd>block</Cmd>,
              or send <Cmd>ignore on</Cmd> inside the group.
            </p>
          </Topic>
          <Topic question="The bot says it needs to be an admin. What does that mean?">
            <p>
              To delete other people's messages or remove members, WhatsApp requires the account to be a group admin. Ask a group admin to make your linked number an admin. The{' '}
              <Go to="groups">Groups</Go> page shows a "Not admin" tag where this applies.
            </p>
          </Topic>
        </section>

        <section className="space-y-3">
          <h2 className="font-semibold">Troubleshooting</h2>
          <Topic question="The bot is not answering. What should I check?">
            <p>
              1. <Go to="overview">Overview</Go> should say "Connected". If not, open <Go to="connection">Connection</Go> and press Connect.
            </p>
            <p>
              2. Check <Go to="access">Access</Go>: in Private mode only owners get answers, and blocked people or ignored groups never do.
            </p>
            <p>
              3. Open <Go to="logs">Logs</Go> and send the message again. Any problem shows up there in plain words. <Go to="activity">Activity</Go> lists everything the bot did.
            </p>
          </Topic>
          <Topic question="Is this safe for my WhatsApp account?">
            <p>
              B-Bot uses the same connection as WhatsApp Web, which WhatsApp does not officially allow for automation. Accounts that send many messages to people who did not ask
              for them get banned. Keep broadcasts small, message people who expect it, and consider using a spare number.
            </p>
          </Topic>
          <Topic question="I forgot the dashboard password.">
            <p>
              Stop B-Bot, add a line <code className="rounded bg-raised px-1 font-mono text-ink">DASHBOARD_PASSWORD=your-new-password</code> to the{' '}
              <code className="rounded bg-raised px-1 font-mono text-ink">.env</code> file in the B-Bot folder, and start it again.
            </p>
          </Topic>
        </section>
      </div>
    </>
  );
}
