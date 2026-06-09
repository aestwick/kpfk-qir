// ===========================================================================
// Passphrase generator for admin-set passwords. Produces a memorable, easy-to-
// dictate string like "Tiger-Maple-River-42" from a curated word list. The list
// isn't secret — its only job is to make the result pronounceable; the security
// comes from picking words with a cryptographically-secure RNG. Four words from
// ~240 + a 2-digit number is roughly 38 bits of entropy, fine for an internal,
// rotatable, admin-shared credential (and the admin can just generate again).
//
// Curated to avoid profanity, look-alike spellings, and homophones, so a word
// dictated over the phone is unambiguous.
// ===========================================================================

export const PASSPHRASE_WORDS: string[] = [
  'anchor', 'amber', 'apple', 'aspen', 'azure', 'badger', 'banjo', 'basil', 'basket', 'beacon',
  'beaver', 'beetle', 'berry', 'birch', 'bison', 'blanket', 'bobcat', 'breeze', 'bronze', 'bucket',
  'butter', 'button', 'cactus', 'candle', 'canyon', 'cedar', 'cherry', 'chisel', 'cliff', 'clover',
  'cloud', 'cocoa', 'comet', 'compass', 'condor', 'cookie', 'copper', 'coral', 'cougar', 'crane',
  'cricket', 'crimson', 'custard', 'daisy', 'dawn', 'delta', 'desert', 'dolphin', 'donkey', 'drizzle',
  'drum', 'duck', 'dune', 'dusk', 'eagle', 'eclipse', 'ember', 'fable', 'falcon', 'fern',
  'ferret', 'fiddle', 'finch', 'flute', 'foal', 'forest', 'frost', 'galaxy', 'gecko', 'ginger',
  'glacier', 'goggles', 'golden', 'goose', 'gosling', 'granite', 'grape', 'grove', 'hammer', 'harbor',
  'harp', 'hawk', 'hazel', 'helmet', 'heron', 'honey', 'horizon', 'iguana', 'indigo', 'island',
  'ivory', 'jackal', 'jasmine', 'jungle', 'kettle', 'kitten', 'koala', 'lagoon', 'lamb', 'lantern',
  'laurel', 'lemon', 'lilac', 'lily', 'llama', 'lotus', 'lynx', 'magpie', 'mango', 'mantis',
  'maple', 'marble', 'marlin', 'marsh', 'meadow', 'melon', 'meteor', 'mint', 'mirror', 'moose',
  'moss', 'muffin', 'nebula', 'noodle', 'oasis', 'olive', 'orchid', 'otter', 'paddle', 'panda',
  'parrot', 'peach', 'pebble', 'pepper', 'pewter', 'piano', 'pickle', 'pigeon', 'piglet', 'pillow',
  'planet', 'plum', 'pony', 'poplar', 'poppy', 'prairie', 'pretzel', 'puffin', 'puppy', 'quail',
  'quartz', 'rabbit', 'rainbow', 'raven', 'ribbon', 'ridge', 'river', 'robin', 'saddle', 'sage',
  'salmon', 'sapphire', 'satchel', 'scarlet', 'silver', 'sparrow', 'spruce', 'stork', 'summit', 'sunrise',
  'sunset', 'swan', 'teal', 'teapot', 'thistle', 'thunder', 'thyme', 'tiger', 'toucan', 'trumpet',
  'tulip', 'tundra', 'turtle', 'twilight', 'valley', 'vanilla', 'velvet', 'violet', 'violin', 'waffle',
  'walnut', 'walrus', 'weasel', 'whistle', 'willow', 'zebra', 'zephyr', 'acorn', 'almond', 'antler',
  'apron', 'arbor', 'arctic', 'autumn', 'bamboo', 'bayou', 'bramble', 'brisk', 'brook', 'cabin',
  'cameo', 'canary', 'cargo', 'cavern', 'cinder', 'citrus', 'cobalt', 'cobble', 'cosmos', 'cove',
  'crater', 'crayon', 'creek', 'crest', 'dahlia', 'denim', 'domino', 'fennel', 'fjord', 'flint',
  'fossil', 'gable', 'garnet', 'geyser', 'glade', 'hamlet', 'hollow', 'jetty', 'juniper', 'kelp',
]

// Uniform random index in [0, n) using crypto, with rejection sampling to avoid
// the modulo bias a plain `% n` would introduce.
function secureIndex(n: number): number {
  const limit = Math.floor(0xffffffff / n) * n
  const buf = new Uint32Array(1)
  let x: number
  do {
    crypto.getRandomValues(buf)
    x = buf[0]
  } while (x >= limit)
  return x % n
}

/**
 * Build a passphrase: `words` capitalized words from the list joined by `-`,
 * plus a trailing 2-digit number (so it satisfies "needs a digit" policies and
 * adds a little entropy). Default 4 words, e.g. "Tiger-Maple-River-Cloud-42".
 */
export function generatePassphrase(words = 4): string {
  const parts: string[] = []
  for (let i = 0; i < words; i++) {
    const w = PASSPHRASE_WORDS[secureIndex(PASSPHRASE_WORDS.length)]
    parts.push(w.charAt(0).toUpperCase() + w.slice(1))
  }
  parts.push(String(secureIndex(90) + 10)) // 10–99
  return parts.join('-')
}
