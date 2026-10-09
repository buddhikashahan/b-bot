// Who made B-Bot. Fixed in the code on purpose: the credit is not a setting.

export const DEVELOPER = {
  name: 'Buddhika Shahan',
  /** WhatsApp number, digits only, with country code. */
  number: '94766866297',
  website: 'https://buddhika.dev',
  github: 'https://github.com/buddhikashahan',
  /** The bot greets the developer's messages in groups with this reaction. */
  reaction: '👨‍💻'
} as const;

export const DEVELOPER_JID = `${DEVELOPER.number}@s.whatsapp.net`;
