// Finding abusive language in group messages, in English and in Sinhala (written in Sinhala
// letters or in English letters). Used by the group filter in group-guard.ts.
//
// The lists are deliberately short and blunt: words that are insults whatever the sentence.
// Mild or ambiguous words stay out, because a filter that removes ordinary talk gets switched
// off. Owners add their own words in the dashboard.

/** English, and Sinhala written in English letters. Matched as whole words. */
const LATIN = [
  // English
  'fuck', 'fucker', 'fuckers', 'fucking', 'fucked', 'fuckin', 'motherfucker', 'motherfuckers', 'mf',
  'shit', 'shits', 'bullshit', 'shitty', 'bitch', 'bitches', 'asshole', 'assholes', 'bastard', 'bastards',
  'dick', 'dickhead', 'cunt', 'cunts', 'pussy', 'slut', 'sluts', 'whore', 'whores', 'cock', 'cocksucker',
  'wanker', 'prick', 'nigger', 'niggers', 'nigga', 'faggot', 'retard', 'retarded',
  // Sinhala in English letters
  'huththa', 'huththo', 'huththi', 'huththige', 'hutta', 'hutto', 'hutti', 'huttige', 'hutha', 'hukanna', 'hukapan', 'hukahan', 'hukanawa',
  'pakaya', 'pakayo', 'pako', 'pakaya', 'ponnaya', 'ponnayo', 'ponna', 'wesi', 'wesige', 'wesiya', 'vesi', 'vesige', 'vesiya',
  'kariya', 'kariyo', 'keriya', 'keriyo', 'pamkaya', 'payya', 'paiya', 'bijja', 'huththigeputha', 'wesigeputha'
];

/** Sinhala letters. Matched anywhere in the text, since Sinhala adds endings to words. */
const SINHALA = ['හුත්ත', 'හුත්ති', 'හුකන', 'හුකප', 'හුකහ', 'පකයා', 'පකයෝ', 'පකෝ', 'පොන්නය', 'පොන්නයෝ', 'වේසි', 'වෙසි', 'කැරියා', 'කැරියෝ', 'පයිය', 'බිජ්ජ'];

/** Letters people swap in to dodge a filter. */
const LOOKALIKES: Record<string, string> = { '@': 'a', '4': 'a', '0': 'o', '1': 'i', '!': 'i', '3': 'e', '$': 's', '5': 's', '7': 't' };

const squash = (word: string) => word.replace(/(.)\1+/g, '$1');
const SQUASHED = new Set(LATIN.map(squash));
const EXACT = new Set(LATIN);
/** Invisible characters dropped into words to split them. The zero-width joiner stays: Sinhala spelling uses it. */
const INVISIBLE = /[​‌⁠﻿]/g;

/**
 * The first abusive word in a message, as it was written, or undefined.
 * @param custom extra words chosen by the owner (matched whole when in English letters, anywhere otherwise)
 */
export function findBadWord(text: string, custom: string[] = []): string | undefined {
  const cleaned = text.normalize('NFC').replace(INVISIBLE, '').toLowerCase();
  const extra = custom.map(word => word.trim().toLowerCase()).filter(Boolean);

  for (const word of [...SINHALA, ...extra.filter(item => /[^\x00-\x7F]/.test(item))]) {
    if (cleaned.includes(word)) return word;
  }

  const extraLatin = new Set(extra.filter(item => !/[^\x00-\x7F]/.test(item)));
  // "f.u.c.k" and "f u c k": single letters strung together with dots or spaces are one word.
  const joined = cleaned.replace(/\b(\w)(?:[\s.*_-]+(?=\w\b))/g, '$1');
  for (const source of joined === cleaned ? [cleaned] : [cleaned, joined]) {
    for (const token of source.split(/[^a-z0-9@$!]+/)) {
      // "!" stands in for "i" inside a word, but at its end it is just punctuation.
      const raw = token.replace(/!+$/, '');
      if (!raw) continue;
      const word = raw.replace(/[@$!0-9]/g, char => LOOKALIKES[char] ?? char);
      if (EXACT.has(word) || extraLatin.has(word) || extraLatin.has(raw)) return raw;
      // "fuuuuck": only stretched words are compared with their repeats removed, so "niger" is not "nigger".
      if (/(.)\1\1/.test(word) && SQUASHED.has(squash(word))) return raw;
    }
  }
  return undefined;
}
