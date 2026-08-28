import { GREEDY_GAME_CODE } from '@/modules/greedy/greedy.constant';
import { GREEDY_CLASSIC_GAME_CODE } from '@/modules/greedy-classic/greedy-classic.constant';
import { LUCKY_77_GAME_CODE } from '@/modules/lucky-77/lucky-77.constant';
import { TEEN_PATTI_GAME_CODE } from '@/modules/teen-patti/teen-patti.constant';

export const BOT_GAME_CODES = [
  GREEDY_GAME_CODE,
  GREEDY_CLASSIC_GAME_CODE,
  TEEN_PATTI_GAME_CODE,
  LUCKY_77_GAME_CODE,
] as const;

export type BotGameCode = (typeof BOT_GAME_CODES)[number];

export const BOT_HANDLE_PATTERN = /^[a-zA-Z]+_\d{2}$/;

const NAMES_PER_GAME = 50;
const PLAIN_NAMES_PER_GAME = 25;
const HANDLE_NAMES_PER_GAME = 25;

/** Authentic BD given names and nicknames used for plain bot display names. */
const BD_PLAIN_NAME_BANK = [
  'Rahim', 'Nusrat', 'Karim', 'Laila', 'Farhan', 'Anika', 'Tanvir', 'Shuvo', 'Nadia', 'Arif',
  'Rashed', 'Tania', 'Kabir', 'Hassan', 'Omar', 'Faiz', 'Amira', 'Imran', 'Salma', 'Jahid',
  'Ruma', 'Sakib', 'Farzana', 'Mahmud', 'Shila', 'Rafiq', 'Yesmin', 'Asif', 'Nasrin', 'Habib',
  'Shahnaz', 'Kamal', 'Rokeya', 'Sohel', 'Parvin', 'Mamun', 'Shirin', 'Raju', 'Jannat', 'Sumon',
  'Ayesha', 'Liton', 'Fahmida', 'Belal', 'Mitu', 'Rubel', 'Shabnam', 'Masud', 'Nazma', 'Tareq',
  'Abdullah', 'Fatema', 'Hasan', 'Rokhsana', 'Iqbal', 'Shamima', 'Jalal', 'Naznin', 'Bashir', 'Lutfa',
  'Shahid', 'Rehana', 'Anwar', 'Firoz', 'Taslima', 'Kamrul', 'Noman', 'Rabeya', 'Sajjad', 'Monira',
  'Ashraf', 'Riaz', 'Nasima', 'Zahid', 'Rashida', 'Sultan', 'Halima', 'Mahbub', 'Jahanara', 'Sohail',
  'Amena', 'Rashid', 'Shamsun', 'Touhid', 'Ferdousi', 'Alamgir', 'Rizia', 'Shahed', 'Nilufa', 'Mizan',
  'Shahin', 'Nazmun', 'Rafsan', 'Afroza', 'Jubayer', 'Sadia', 'Babul', 'Minu', 'Chanchal', 'Putul',
  'Gopal', 'Khushi', 'Bikash', 'Rupa', 'Dipu', 'Shampa', 'Pavel', 'Mousumi', 'Ripon', 'Beauty',
  'Bappy', 'Rani', 'Shakil', 'Poly', 'Jewel', 'Shathi', 'Rasel', 'Laboni', 'Sagor', 'Purnima',
  'Mintu', 'Shilpi', 'Babu', 'Rina', 'Noyon', 'Sraboni', 'Pappu', 'Trisha', 'Shohag', 'Mim',
  'Rony', 'Oishi', 'Brishty', 'Naim', 'Tumpa', 'Faisal', 'Orpa', 'Shanto', 'Meghla', 'Rifat',
  'Mahin', 'Nishi', 'Adnan', 'Sultana', 'Tamim', 'Mashrafe', 'Mushfiq', 'Shakib', 'Mustafiz', 'Mehidy',
  'Soumya', 'Afif', 'Taskin', 'Ebadot', 'Nasum', 'Miraz', 'Jaker', 'Shamim',
  'Nayeem', 'Mahedi', 'Saifuddin', 'Mominul', 'Mushfiqur', 'Enamul', 'Riyad', 'Mahmudullah',
] as const;

/** Romanized bases reserved for username-style handles (disjoint from plain names). */
const BD_HANDLE_BASE_BANK = [
  'rakib', 'sumit', 'nadia', 'arif', 'tanvir', 'shuvo', 'farhan', 'anika', 'karim', 'laila',
  'imran', 'salma', 'jahid', 'ruma', 'asif', 'nasrin', 'habib', 'kamal', 'sohel', 'parvin',
  'mamun', 'raju', 'sumon', 'liton', 'belal', 'rubel', 'masud', 'tareq', 'iqbal', 'jalal',
  'bashir', 'shahid', 'anwar', 'firoz', 'kamrul', 'noman', 'sajjad', 'ashraf', 'riaz', 'zahid',
  'sultan', 'mahbub', 'sohail', 'amena', 'touhid', 'alamgir', 'shahed', 'mizan', 'shahin', 'jubayer',
  'babul', 'chanchal', 'gopal', 'bikash', 'dipu', 'pavel', 'ripon', 'bappy', 'shakil', 'jewel',
  'rasel', 'sagor', 'mintu', 'babu', 'noyon', 'pappu', 'shohag', 'rony', 'oishi', 'naim',
  'tumpa', 'faisal', 'orpa', 'meghla', 'rifat', 'mahin', 'nishi', 'adnan', 'tamim', 'afif',
  'taskin', 'miraz', 'jaker', 'shamim', 'nayeem', 'mahedi', 'mominul', 'riyad', 'enamul', 'rubelh',
  'putul', 'khushi', 'rupa', 'shampa', 'mousumi', 'beauty', 'poly', 'shathi', 'laboni', 'purnima',
  'shilpi', 'sraboni', 'trisha', 'mim', 'brishty', 'shanto', 'sultana', 'rokib', 'sabbir', 'nayem',
] as const;

const isBotHandle = (name: string): boolean => BOT_HANDLE_PATTERN.test(name);

export const stylizeHandle = (base: string, suffix: number): string => {
  const letters = base.toLowerCase().replace(/[^a-z]/g, '').slice(0, 6);
  if (letters.length < 3) {
    throw new Error(`Handle base "${base}" is too short after normalization`);
  }
  const styled = letters.length <= 4
    ? letters.slice(0, 2).toLowerCase() + letters.slice(2).toUpperCase()
    : letters.slice(0, 2).toLowerCase() + letters.slice(2).toUpperCase();
  return `${styled}_${String(suffix).padStart(2, '0')}`;
};

const seededShuffle = <T>(items: readonly T[], seed: number): T[] => {
  const result = [...items];
  let state = seed >>> 0;
  for (let i = result.length - 1; i > 0; i -= 1) {
    state = (Math.imul(1_664_525, state) + 1_013_904_223) >>> 0;
    const j = state % (i + 1);
    const temp = result[i]!;
    result[i] = result[j]!;
    result[j] = temp;
  }
  return result;
};

const buildGamePool = (
  plain_names: readonly string[],
  handle_bases: readonly string[],
  suffix_start: number,
  shuffle_seed: number,
): readonly string[] => {
  if (plain_names.length !== PLAIN_NAMES_PER_GAME) {
    throw new Error(`Expected ${PLAIN_NAMES_PER_GAME} plain names, got ${plain_names.length}`);
  }
  if (handle_bases.length !== HANDLE_NAMES_PER_GAME) {
    throw new Error(`Expected ${HANDLE_NAMES_PER_GAME} handle bases, got ${handle_bases.length}`);
  }

  const handles = handle_bases.map((base, index) => stylizeHandle(base, suffix_start + index));
  return seededShuffle([...plain_names, ...handles], shuffle_seed);
};

const slicePlainNames = (offset: number): readonly string[] =>
  BD_PLAIN_NAME_BANK.slice(offset, offset + PLAIN_NAMES_PER_GAME);

const sliceHandleBases = (offset: number): readonly string[] =>
  BD_HANDLE_BASE_BANK.slice(offset, offset + HANDLE_NAMES_PER_GAME);

/** 50 unique names per game: 25 plain BD names + 25 username handles (200 total, no cross-game overlap). */
export const BOT_NAME_POOLS: Record<BotGameCode, readonly string[]> = {
  [GREEDY_GAME_CODE]: buildGamePool(slicePlainNames(0), sliceHandleBases(0), 12, 0x47_52_45_45_44),
  [GREEDY_CLASSIC_GAME_CODE]: buildGamePool(slicePlainNames(25), sliceHandleBases(25), 12, 0x43_4c_41_53_53),
  [TEEN_PATTI_GAME_CODE]: buildGamePool(slicePlainNames(50), sliceHandleBases(50), 12, 0x54_45_45_4e),
  [LUCKY_77_GAME_CODE]: buildGamePool(slicePlainNames(75), sliceHandleBases(75), 12, 0x4c_55_43_4b),
};

export const assertBotNamePools = (): void => {
  const seen = new Set<string>();
  const seen_plain = new Set<string>();
  const seen_handle_roots = new Set<string>();

  for (const game_code of BOT_GAME_CODES) {
    const names = BOT_NAME_POOLS[game_code];
    if (names.length !== NAMES_PER_GAME) {
      throw new Error(`Bot name pool for ${game_code} must have ${NAMES_PER_GAME} names, got ${names.length}`);
    }

    let handle_count = 0;
    let plain_count = 0;

    for (const name of names) {
      const key = name.toLowerCase();
      if (seen.has(key)) {
        throw new Error(`Duplicate bot display name across pools: ${name}`);
      }
      seen.add(key);

      if (isBotHandle(name)) {
        handle_count += 1;
        const root = name.slice(0, name.indexOf('_')).toLowerCase();
        if (seen_handle_roots.has(root)) {
          throw new Error(`Duplicate handle root across pools: ${root}`);
        }
        seen_handle_roots.add(root);
        if (!BOT_HANDLE_PATTERN.test(name)) {
          throw new Error(`Invalid handle format for ${game_code}: ${name}`);
        }
      } else {
        plain_count += 1;
        if (seen_plain.has(key)) {
          throw new Error(`Duplicate plain bot name across pools: ${name}`);
        }
        seen_plain.add(key);
      }
    }

    if (plain_count !== PLAIN_NAMES_PER_GAME) {
      throw new Error(`Bot name pool for ${game_code} must have ${PLAIN_NAMES_PER_GAME} plain names, got ${plain_count}`);
    }
    if (handle_count !== HANDLE_NAMES_PER_GAME) {
      throw new Error(`Bot name pool for ${game_code} must have ${HANDLE_NAMES_PER_GAME} handles, got ${handle_count}`);
    }
  }
};

assertBotNamePools();

export const botGameSlug = (game_code: BotGameCode): string => {
  switch (game_code) {
    case GREEDY_GAME_CODE:
      return 'greedy';
    case GREEDY_CLASSIC_GAME_CODE:
      return 'classic';
    case TEEN_PATTI_GAME_CODE:
      return 'teen';
    case LUCKY_77_GAME_CODE:
      return 'lucky';
    default: {
      const _exhaustive: never = game_code;
      return _exhaustive;
    }
  }
};
