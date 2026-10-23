// Devanagari → Roman, readable rather than scholarly: "आज हम पढ़ेंगे" → "aaj ham
// padhenge". Used for the Roman view of a transcript and so that a search typed
// in either script finds the line.
//
// Rules: consonants carry an inherent "a" unless followed by a vowel sign or
// virama; that "a" is dropped at the end of a word of two or more syllables
// ("हम" → "ham", not "hama") and before a final consonant + vowel-sign
// syllable in longer words ("समझना" → "samajhna"). A long vowel at the very
// end is written short, as Hinglish usually is ("क्या" → "kya", "ज़रूरी" →
// "zaroori"). A small table covers very common words whose spoken
// Hinglish spelling differs from the letters ("में" → "mein"). Anything not
// Devanagari — English words, digits, punctuation — passes through unchanged.

const VOWELS: Record<string, string> = {
  "अ": "a", "आ": "aa", "इ": "i", "ई": "ee", "उ": "u", "ऊ": "oo", "ऋ": "ri",
  "ए": "e", "ऐ": "ai", "ओ": "o", "औ": "au", "ऑ": "o", "ऍ": "e",
};

const SIGNS: Record<string, string> = {
  "ा": "aa", "ि": "i", "ी": "ee", "ु": "u", "ू": "oo", "ृ": "ri",
  "े": "e", "ै": "ai", "ो": "o", "ौ": "au", "ॉ": "o", "ॅ": "e",
};

const CONSONANTS: Record<string, string> = {
  "क": "k", "ख": "kh", "ग": "g", "घ": "gh", "ङ": "n",
  "च": "ch", "छ": "chh", "ज": "j", "झ": "jh", "ञ": "n",
  "ट": "t", "ठ": "th", "ड": "d", "ढ": "dh", "ण": "n",
  "त": "t", "थ": "th", "द": "d", "ध": "dh", "न": "n",
  "प": "p", "फ": "ph", "ब": "b", "भ": "bh", "म": "m",
  "य": "y", "र": "r", "ल": "l", "व": "v",
  "श": "sh", "ष": "sh", "स": "s", "ह": "h",
  "क़": "q", "ख़": "kh", "ग़": "gh", "ज़": "z", "ड़": "d", "ढ़": "dh", "फ़": "f", "य़": "y",
};

// Base consonant + nukta, as Whisper may emit either form.
const NUKTA_FORMS: Record<string, string> = {
  "क": "क़", "ख": "ख़", "ग": "ग़", "ज": "ज़", "ड": "ड़", "ढ": "ढ़", "फ": "फ़", "य": "य़",
};

const VOWEL_ROMANS = new Set(Object.values(VOWELS));
const SHORT_FINAL: Record<string, string> = { aa: "a", ee: "i" };

const VIRAMA = "्";
const NUKTA = "़";
const ANUSVARA = "ं";
const CHANDRABINDU = "ँ";
const VISARGA = "ः";

const DIGITS = "०१२३४५६७८९";

const COMMON: Record<string, string> = {
  "है": "hai", "हैं": "hain", "में": "mein", "मैं": "main", "नहीं": "nahi", "यह": "yeh",
  "वह": "woh", "ये": "ye", "वो": "wo", "क्यों": "kyon", "हूँ": "hoon", "हूं": "hoon",
  "और": "aur", "तो": "to", "भी": "bhi", "कि": "ki", "कर": "kar", "रहा": "raha",
};

type Token = { kind: "consonant"; roman: string; vowel: string | null } | { kind: "other"; roman: string };

function tokenize(word: string): Token[] {
  const chars = [...word];
  const tokens: Token[] = [];
  for (let i = 0; i < chars.length; i++) {
    let ch = chars[i]!;
    if (chars[i + 1] === NUKTA && NUKTA_FORMS[ch]) {
      ch = NUKTA_FORMS[ch]!;
      i++;
    }
    if (CONSONANTS[ch] !== undefined) {
      const next = chars[i + 1];
      let vowel: string | null = "a"; // inherent vowel, possibly dropped later
      if (next === VIRAMA) {
        vowel = "";
        i++;
      } else if (next !== undefined && SIGNS[next] !== undefined) {
        vowel = SIGNS[next]!;
        i++;
      }
      tokens.push({ kind: "consonant", roman: CONSONANTS[ch]!, vowel });
      continue;
    }
    if (VOWELS[ch] !== undefined) tokens.push({ kind: "other", roman: VOWELS[ch]! });
    else if (ch === ANUSVARA || ch === CHANDRABINDU) tokens.push({ kind: "other", roman: "n" });
    else if (ch === VISARGA) tokens.push({ kind: "other", roman: "h" });
    else if (ch === "।" || ch === "॥") tokens.push({ kind: "other", roman: "." });
    else if (DIGITS.includes(ch)) tokens.push({ kind: "other", roman: String(DIGITS.indexOf(ch)) });
    else tokens.push({ kind: "other", roman: ch });
  }
  return tokens;
}

/** Indices of consonants whose inherent "a" is silent in speech. */
function schwaDeletions(tokens: Token[]): Set<number> {
  const drop = new Set<number>();
  const consonants = tokens.flatMap((t, i) => (t.kind === "consonant" ? [i] : []));
  const syllables = tokens.filter((t) => (t.kind === "consonant" ? t.vowel !== "" : VOWEL_ROMANS.has(t.roman))).length;
  if (consonants.length === 0 || syllables < 2) return drop; // "न" stays "na"

  // Final: "हम" → "ham".
  const last = consonants[consonants.length - 1]!;
  const lastToken = tokens[last] as Extract<Token, { kind: "consonant" }>;
  if (lastToken.vowel === "a" && last === tokens.length - 1) drop.add(last);

  // Medial: in a word of three or more syllables, the "a" before a final
  // consonant-with-vowel-sign syllable is dropped: "समझना" → "samajhna".
  if (consonants.length >= 3 && lastToken.vowel !== "a" && lastToken.vowel !== "") {
    const before = consonants[consonants.length - 2]!;
    const t = tokens[before] as Extract<Token, { kind: "consonant" }>;
    if (t.vowel === "a" && before === last - 1) drop.add(before);
  }
  return drop;
}

function wordToRoman(word: string): string {
  if (COMMON[word]) return COMMON[word]!;
  const tokens = tokenize(word);
  const drop = schwaDeletions(tokens);
  const lastIndex = tokens.length - 1;
  return tokens
    .map((t, i) => {
      if (t.kind !== "consonant") return t.roman;
      if (drop.has(i)) return t.roman;
      const vowel = t.vowel ?? "";
      return t.roman + (i === lastIndex && tokens.length > 1 ? (SHORT_FINAL[vowel] ?? vowel) : vowel);
    })
    .join("");
}

// Words exclude the danda (U+0964-5) so that "में।" still matches "में".
const DEVANAGARI_RUN = /[\u0900-\u0963\u0966-\u097F]+/g;

export function hasDevanagari(text: string): boolean {
  return /[\u0900-\u097F]/.test(text);
}

export function toRoman(text: string): string {
  return text.replace(DEVANAGARI_RUN, (word) => wordToRoman(word)).replace(/[।॥]/g, ".");
}

/** Lowercased text in both scripts, for matching a query typed in either. */
export function searchKey(text: string): string {
  return (hasDevanagari(text) ? `${text} ${toRoman(text)}` : text).toLowerCase();
}
