import {
  isLidUser,
  isPnUser,
  jidDecode,
  jidNormalizedUser,
  normalizeMessageContent,
  type AnyMessageContent,
  type GroupParticipant,
  type WAMessage,
  type proto
} from '@whiskeysockets/baileys';

export type MediaKind = 'image' | 'video' | 'audio' | 'document' | 'sticker';
export type MessageKind = MediaKind | 'text' | 'contact' | 'location' | 'poll' | 'other';

export interface MediaInfo {
  kind: MediaKind;
  mime: string;
  fileName?: string;
  caption?: string;
  /** Voice note / round video flags, preserved when re-sending. */
  ptt?: boolean;
  ptv?: boolean;
  gif?: boolean;
  sizeBytes?: number;
}

/** Message content with ephemeral / view-once / edited wrappers peeled off. */
export function contentOf(message: proto.IMessage | null | undefined): proto.IMessage | undefined {
  return normalizeMessageContent(message);
}

export function textOf(content: proto.IMessage | undefined): string {
  if (!content) return '';
  return (
    content.conversation ??
    content.extendedTextMessage?.text ??
    content.imageMessage?.caption ??
    content.videoMessage?.caption ??
    content.documentMessage?.caption ??
    ''
  );
}

export function mediaOf(content: proto.IMessage | undefined): MediaInfo | undefined {
  if (!content) return undefined;
  const size = (value: unknown) => (value == null ? undefined : Number(value));
  if (content.imageMessage) {
    const m = content.imageMessage;
    return { kind: 'image', mime: m.mimetype ?? 'image/jpeg', caption: m.caption ?? undefined, sizeBytes: size(m.fileLength) };
  }
  if (content.videoMessage) {
    const m = content.videoMessage;
    return {
      kind: 'video',
      mime: m.mimetype ?? 'video/mp4',
      caption: m.caption ?? undefined,
      gif: m.gifPlayback ?? undefined,
      sizeBytes: size(m.fileLength)
    };
  }
  if (content.ptvMessage) {
    const m = content.ptvMessage;
    return { kind: 'video', mime: m.mimetype ?? 'video/mp4', ptv: true, sizeBytes: size(m.fileLength) };
  }
  if (content.audioMessage) {
    const m = content.audioMessage;
    return { kind: 'audio', mime: m.mimetype ?? 'audio/ogg; codecs=opus', ptt: m.ptt ?? undefined, sizeBytes: size(m.fileLength) };
  }
  if (content.documentMessage) {
    const m = content.documentMessage;
    return {
      kind: 'document',
      mime: m.mimetype ?? 'application/octet-stream',
      fileName: m.fileName ?? undefined,
      caption: m.caption ?? undefined,
      sizeBytes: size(m.fileLength)
    };
  }
  if (content.stickerMessage) {
    const m = content.stickerMessage;
    return { kind: 'sticker', mime: m.mimetype ?? 'image/webp', sizeBytes: size(m.fileLength) };
  }
  return undefined;
}

export function kindOf(content: proto.IMessage | undefined): MessageKind {
  const media = mediaOf(content);
  if (media) return media.kind;
  if (!content) return 'other';
  if (content.conversation != null || content.extendedTextMessage) return 'text';
  if (content.contactMessage || content.contactsArrayMessage) return 'contact';
  if (content.locationMessage || content.liveLocationMessage) return 'location';
  if (content.pollCreationMessage || content.pollCreationMessageV2 || content.pollCreationMessageV3) return 'poll';
  return 'other';
}

export function isViewOnce(message: proto.IMessage | null | undefined): boolean {
  if (!message) return false;
  const outer = message.ephemeralMessage?.message ?? message;
  if (outer.viewOnceMessage || outer.viewOnceMessageV2 || outer.viewOnceMessageV2Extension) return true;
  // Newer clients drop the wrapper and flag the media node itself.
  const content = contentOf(outer);
  return Boolean(content?.imageMessage?.viewOnce || content?.videoMessage?.viewOnce || content?.audioMessage?.viewOnce);
}

export function contextInfoOf(content: proto.IMessage | undefined): proto.IContextInfo | undefined {
  if (!content) return undefined;
  return (
    content.extendedTextMessage?.contextInfo ??
    content.imageMessage?.contextInfo ??
    content.videoMessage?.contextInfo ??
    content.documentMessage?.contextInfo ??
    content.audioMessage?.contextInfo ??
    content.stickerMessage?.contextInfo ??
    undefined
  );
}

/** Every address WhatsApp gave us for whoever wrote this message (phone-number and LID forms). */
export function senderIdsOf(msg: WAMessage): string[] {
  const { key } = msg;
  const isGroupLike = Boolean(key.participant);
  const ids = isGroupLike ? [key.participant, key.participantAlt] : [key.remoteJid, key.remoteJidAlt];
  return [...new Set(ids.filter((id): id is string => Boolean(id)).map(id => jidNormalizedUser(id)))];
}

/** Prefer the phone-number JID for display and mentions when we have one. */
export function preferPn(ids: string[]): string | undefined {
  return ids.find(id => isPnUser(id)) ?? ids[0];
}

export function userPart(jid: string | undefined): string {
  return jidDecode(jid)?.user ?? jid?.split('@')[0] ?? '';
}

/** "+15551234567" for phone JIDs, "@123..." style tag for anything else. */
export function displayNumber(jid: string | undefined): string {
  if (!jid) return 'unknown';
  if (isPnUser(jid)) return `+${userPart(jid)}`;
  if (isLidUser(jid)) return `LID ${userPart(jid)}`;
  return jid;
}

/** Every address (id / LID / phone number) WhatsApp lists for a group member. */
export function participantIds(participant: GroupParticipant): string[] {
  return [participant.id, participant.lid, participant.phoneNumber]
    .filter((id): id is string => Boolean(id))
    .map(id => jidNormalizedUser(id));
}

export function phoneToJid(phone: string): string {
  return `${phone.replace(/\D/g, '')}@s.whatsapp.net`;
}

export function timestampOf(msg: WAMessage): Date {
  const seconds = Number(msg.messageTimestamp ?? 0);
  return seconds > 0 ? new Date(seconds * 1000) : new Date();
}

/** Build outgoing content for a buffer or a file on disk. */
export function mediaContent(
  info: MediaInfo,
  source: Buffer | { url: string },
  caption?: string,
  mentions?: string[]
): AnyMessageContent {
  switch (info.kind) {
    case 'image':
      return { image: source, caption, mimetype: info.mime, mentions };
    case 'video':
      return { video: source, caption, mimetype: info.mime, gifPlayback: info.gif, ptv: info.ptv, mentions };
    case 'audio':
      return { audio: source, mimetype: info.mime, ptt: info.ptt };
    case 'sticker':
      return { sticker: source };
    default:
      return { document: source, mimetype: info.mime, fileName: info.fileName ?? 'file', caption, mentions };
  }
}

/** Kinds that can carry a caption; the rest need their text sent as a separate message. */
export function supportsCaption(kind: MediaKind): boolean {
  return kind === 'image' || kind === 'video' || kind === 'document';
}

export function kindFromMime(mime: string): MediaKind {
  if (mime === 'image/webp') return 'sticker';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'document';
}
