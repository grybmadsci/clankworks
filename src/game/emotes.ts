/** Emote catalogue from the design doc: the text a bot shouts and how cheerful the chirp is. */
export const EMOTES = {
  cogAndStone: { text: 'Cog and Stone!', mood: 1 },
  strikeTheEarth: { text: 'Strike the Earth!', mood: 1 },
  losingIsOptimal: { text: 'Losing Is Optimal!', mood: 0.5 },
  quarryMustGrow: { text: 'The Quarry Must Grow!', mood: 1 },
  oxygenNotIncluded: { text: 'Oxygen Not Included!', mood: 0 },
  forCarl: { text: 'For Carl!', mood: -0.3 },
  tantrum: { text: 'Tantrum Protocol Initiated!', mood: -1 },
  stressNominal: { text: 'Stress Level: Nominal-ish!', mood: 0.2 },
} as const;

export type EmoteId = keyof typeof EMOTES;
