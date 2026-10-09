// Forward a WhatsApp message to several chats without downloading the file.
// Works with @whiskeysockets/baileys 7.x. `sock` is an already connected socket.
import { getContentType, normalizeMessageContent } from '@whiskeysockets/baileys';

/**
 * @param sock    connected Baileys socket
 * @param reply   the message that replies to the one you want to forward
 * @param targets chat IDs, e.g. ['94771234567@s.whatsapp.net', '1203630xxxxxxx@g.us']
 */
export async function forwardQuoted(sock, reply, targets) {
  const content = normalizeMessageContent(reply.message);
  const context = content?.extendedTextMessage?.contextInfo;
  const quoted = normalizeMessageContent(context?.quotedMessage);
  if (!quoted) throw new Error('Reply to the message you want to forward.');

  // Keep only the real content (documentMessage, videoMessage, ...), not the old reply context.
  const type = getContentType(quoted);
  const original = {
    key: { remoteJid: reply.key.remoteJid, id: context.stanzaId, participant: context.participant, fromMe: false },
    message: { [type]: quoted[type] }
  };

  for (const jid of targets) {
    // `forward` copies the message as it is: no download, no upload.
    await sock.sendMessage(jid, { forward: original });
    await new Promise(resolve => setTimeout(resolve, 700)); // small pause, so it is not one burst
  }
}

// Example: the account owner replies to a file with ".forward 94771234567 1203630xxxxxxx@g.us"
sock.ev.on('messages.upsert', async ({ messages }) => {
  for (const msg of messages) {
    if (!msg.key.fromMe) continue; // only the owner may forward
    const text = normalizeMessageContent(msg.message)?.extendedTextMessage?.text ?? '';
    if (!text.startsWith('.forward ')) continue;

    const targets = text
      .slice('.forward '.length)
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(target => (target.includes('@') ? target : `${target.replace(/\D/g, '')}@s.whatsapp.net`));
    await forwardQuoted(sock, msg, targets);
  }
});
