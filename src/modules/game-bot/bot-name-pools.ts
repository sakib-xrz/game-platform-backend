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

/** 50 unique Bangladesh-style given names per game (200 total, no cross-game overlap). */
export const BOT_NAME_POOLS: Record<BotGameCode, readonly string[]> = {
  [GREEDY_GAME_CODE]: [
    'Rahim',
    'Nusrat',
    'Karim',
    'Laila',
    'Farhan',
    'Anika',
    'Tanvir',
    'Shuvo',
    'Nadia',
    'Arif',
    'Rashed',
    'Tania',
    'Kabir',
    'Hassan',
    'Omar',
    'Faiz',
    'Amira',
    'Imran',
    'Salma',
    'Jahid',
    'Ruma',
    'Sakib',
    'Farzana',
    'Mahmud',
    'Shila',
    'Rafiq',
    'Yesmin',
    'Asif',
    'Nasrin',
    'Habib',
    'Shahnaz',
    'Kamal',
    'Rokeya',
    'Sohel',
    'Parvin',
    'Mamun',
    'Shirin',
    'Raju',
    'Jannat',
    'Sumon',
    'Ayesha',
    'Liton',
    'Fahmida',
    'Belal',
    'Mitu',
    'Rubel',
    'Shabnam',
    'Masud',
    'Nazma',
    'Tareq',
  ],
  [GREEDY_CLASSIC_GAME_CODE]: [
    'Aarav',
    'Sara',
    'Maya',
    'Priya',
    'Meera',
    'Elina',
    'Samir',
    'Diya',
    'Zara',
    'Isha',
    'Naveen',
    'Riya',
    'Ananya',
    'Rohan',
    'Ishita',
    'Dev',
    'Kavya',
    'Aditya',
    'Sneha',
    'Vikram',
    'Pooja',
    'Arjun',
    'Neha',
    'Kunal',
    'Aisha',
    'Rahul',
    'Sania',
    'Vivek',
    'Anvi',
    'Nikhil',
    'Ira',
    'Siddharth',
    'Tara',
    'Aryan',
    'Kiara',
    'Yash',
    'Mira',
    'Reyansh',
    'Sana',
    'Kabya',
    'Ansh',
    'Myra',
    'Vihaan',
    'Aarohi',
    'Dhruv',
    'Navya',
    'Shaurya',
    'Anikaa',
    'Kabiraj',
    'Lavanya',
  ],
  [TEEN_PATTI_GAME_CODE]: [
    'Abdullah',
    'Fatema',
    'Hasan',
    'Rokhsana',
    'Iqbal',
    'Shamima',
    'Jalal',
    'Naznin',
    'Bashir',
    'Lutfa',
    'Shahid',
    'Rehana',
    'Anwar',
    'Salma Begum',
    'Firoz',
    'Taslima',
    'Kamrul',
    'Shahnaz Begum',
    'Noman',
    'Rabeya',
    'Sajjad',
    'Monira',
    'Ashraf',
    'Shamima Akter',
    'Riaz',
    'Nasima',
    'Zahid',
    'Rashida',
    'Sultan',
    'Halima',
    'Mahbub',
    'Jahanara',
    'Sohail',
    'Amena',
    'Rashid',
    'Shamsun',
    'Touhid',
    'Ferdousi',
    'Alamgir',
    'Rizia',
    'Shahed',
    'Nilufa',
    'Mizan',
    'Shirin Akter',
    'Shahin',
    'Nazmun',
    'Rafsan',
    'Afroza',
    'Jubayer',
    'Sadia',
  ],
  [LUCKY_77_GAME_CODE]: [
    'Babul',
    'Minu',
    'Chanchal',
    'Putul',
    'Gopal',
    'Khushi',
    'Bikash',
    'Rupa',
    'Dipu',
    'Shampa',
    'Pavel',
    'Mousumi',
    'Ripon',
    'Beauty',
    'Bappy',
    'Rani',
    'Shakil',
    'Poly',
    'Jewel',
    'Shathi',
    'Rasel',
    'Laboni',
    'Sagor',
    'Purnima',
    'Mintu',
    'Shilpi',
    'Babu',
    'Rina',
    'Noyon',
    'Sraboni',
    'Pappu',
    'Trisha',
    'Shohag',
    'Mim',
    'Rony',
    'Oishi',
    'Shuvo Roy',
    'Brishty',
    'Naim',
    'Tumpa',
    'Faisal',
    'Orpa',
    'Shanto',
    'Meghla',
    'Rifat',
    'Anika Islam',
    'Mahin',
    'Nishi',
    'Adnan',
    'Sultana',
  ],
};

export const assertBotNamePools = (): void => {
  const seen = new Set<string>();
  for (const game_code of BOT_GAME_CODES) {
    const names = BOT_NAME_POOLS[game_code];
    if (names.length !== 50) {
      throw new Error(`Bot name pool for ${game_code} must have 50 names, got ${names.length}`);
    }
    for (const name of names) {
      const key = name.toLowerCase();
      if (seen.has(key)) {
        throw new Error(`Duplicate bot display name across pools: ${name}`);
      }
      seen.add(key);
    }
  }
};

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
